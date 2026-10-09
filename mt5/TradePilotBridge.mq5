//+------------------------------------------------------------------+
//|                                        TradePilotBridge.mq5      |
//|                                                                  |
//|  TradePilot ⇄ MetaTrader 5 bridge Expert Advisor                 |
//|                                                                  |
//|  WHAT IT DOES                                                     |
//|    • Reports account state, symbol specifications, live ticks,     |
//|      open positions, pending orders and deal history to your own   |
//|      TradePilot backend over HTTPS (WebRequest — no DLLs).         |
//|    • Polls the backend for signed commands and executes them with  |
//|      full re-validation inside the terminal.                       |
//|    • Never asks for, stores or transmits your MT5 password. It     |
//|      runs inside the terminal you are already logged into and uses |
//|      a revocable device token as its only credential.              |
//|                                                                  |
//|  BEFORE YOU START                                                 |
//|    1. Tools → Options → Expert Advisors → add your backend origin  |
//|       (e.g. https://trade.example.com) to "Allow WebRequest for    |
//|       listed URL" and enable "Allow WebRequest for listed URL".    |
//|    2. Paste the device token from TradePilot →                    |
//|       Settings → MT5 Connection into InpDeviceToken.               |
//|    3. Enable "Algo Trading" in the MT5 toolbar.                    |
//|    4. Keep the terminal online; the EA heartbeats every few        |
//|       seconds and the web app marks LIVE as unavailable the moment |
//|       heartbeats stop.                                             |
//|                                                                  |
//|  SAFETY                                                           |
//|    • Close-all requires the exact confirmation text the web UI      |
//|      makes the user type; the EA re-checks it before acting.       |
//|    • Commands are HMAC-signed, timestamped and single-use; a        |
//|      replayed or tampered command is refused and reported.          |
//|    • The EA refuses to trade when the account login changed under   |
//|      it: it re-registers instead of touching someone else's money.  |
//|                                                                  |
//|  This file is original TradePilot code. Install instructions:      |
//|  docs/MT5_EA_INSTALL.md                                            |
//+------------------------------------------------------------------+
#property copyright   "TradePilot"
#property description "TradePilot ⇄ MT5 bridge: account/quote/position reporting and signed order execution."
#property version     "1.00"
#property strict

// The include files ship in mt5/include/TradePilot and must be copied to
// <terminal-data>/MQL5/Include/TradePilot (see docs/MT5_EA_INSTALL.md).
#include <TradePilot/TP_Protocol.mq5>
#include <TradePilot/TP_Http.mq5>
#include <TradePilot/TP_Trade.mq5>

//--- input parameters -----------------------------------------------
input group "Backend"
input string InpBackendUrl            = "https://YOUR-BACKEND-HOST";  // TradePilot backend URL (https://host, no trailing /)
input string InpDeviceToken           = "";                          // Device token from Settings → MT5 Connection (tpd_…, shown once)
input int    InpHeartbeatSeconds      = 3;                           // Heartbeat interval (2–5 s recommended)
input int    InpPollIntervalMs        = 1500;                        // Command poll interval (ms)
input int    InpRequestTimeoutMs      = 10000;                       // HTTP timeout (ms)
input int    InpSymbolRefreshMinutes  = 5;                           // Re-push symbol specifications every N minutes
input int    InpAccountPushSeconds    = 5;                           // Account snapshot interval (s)
input int    InpPositionPushSeconds   = 2;                           // Position/order push interval (s)
input int    InpHistoryPushMinutes    = 2;                           // Closed-deal history push interval (minutes)
input int    InpClockSkewSeconds      = 180;                         // Allowed clock difference for signed commands (s)

input group "Trading"
input bool   InpEnableTrading         = true;                        // Allow the EA to execute commands (false = reporting only)
input long   InpMagicNumber           = 700200;                      // Magic number for TradePilot live orders
input int    InpDeviationPoints       = 20;                          // Maximum slippage (points)
input string InpCommentPrefix         = "TradePilot";                // Comment prefix on orders
input bool   InpManageOnlyOwnMagic    = false;                       // When true, close-all only closes TradePilot positions

input group "Diagnostics"
input bool   InpVerboseLog            = false;                       // Verbose Experts-log output
input bool   InpShowChartStatus       = true;                        // Show a status line on the chart

//--- globals --------------------------------------------------------
TP_Protocol g_protocol;
TP_Http     g_http;
TP_Trade    g_trade;

string   g_eaVersion       = "1.00";
string   g_symbols[];
datetime g_lastHeartbeat   = 0;
datetime g_lastAccountPush = 0;
datetime g_lastPositionPush = 0;
datetime g_lastSymbolPush  = 0;
datetime g_lastHistoryPush = 0;
datetime g_lastPoll        = 0;
long     g_registeredLogin = 0;
string   g_lastStatus      = "starting…";
int      g_lastHttpStatus  = 0;
int      g_commandsExecuted = 0;
int      g_commandsFailed   = 0;
bool     g_tokenValid      = false;
bool     g_urlReady        = false;
// Effective command-poll interval; the backend may tune it in its heartbeat
// reply (next_poll_ms) and it stays inside a sane range.
int      g_pollIntervalMs  = 1500;

//+------------------------------------------------------------------+
//| Helpers                                                           |
//+------------------------------------------------------------------+
void TP_Log(const string message, const bool always = false)
{
   if(InpVerboseLog || always)
      Print("[TradePilot] ", message);
}

void TP_Status(const string message)
{
   g_lastStatus = message;
   if(InpShowChartStatus)
      Comment("TradePilot bridge\n", message,
              "\naccount: ", IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)),
              "\nserver:  ", AccountInfoString(ACCOUNT_SERVER),
              "\ncommands: ", IntegerToString(g_commandsExecuted), " ok / ", IntegerToString(g_commandsFailed), " failed",
              "\nbackend: ", g_http.BaseUrl());
   TP_Log(message);
}

//+------------------------------------------------------------------+
//| Split the device token into device id + secret                     |
//+------------------------------------------------------------------+
bool TP_ParseDeviceToken(const string token, string &deviceId, string &secret)
{
   deviceId = "";
   secret = "";
   string trimmed = token;
   StringTrimLeft(trimmed);
   StringTrimRight(trimmed);
   if(trimmed == "")
      return false;

   string parts[];
   int count = StringSplit(trimmed, '_', parts);
   if(count != 3 || parts[0] != "tpd")
      return false;
   if(StringLen(parts[1]) < 6 || StringLen(parts[2]) < 16)
      return false;
   deviceId = parts[1];
   secret = parts[2];
   return true;
}

//+------------------------------------------------------------------+
//| POST a JSON body, logging transport failures once per event        |
//+------------------------------------------------------------------+
bool TP_Post(const string path, const string payloadJson, string &responseBody, const bool quiet = false)
{
   TP_HttpResponse response;
   bool ok = g_http.Post(path, g_protocol.Envelope(payloadJson), response);
   g_lastHttpStatus = response.status;
   responseBody = response.body;

   if(ok)
   {
      g_http.NoteSuccess();
      if(InpVerboseLog)
         TP_Log("POST " + path + " → " + IntegerToString(response.status) + " (" + IntegerToString((int)response.durationMs) + " ms)");
      return true;
   }

   g_http.NoteFailure();
   if(!quiet)
      TP_Status("backend request failed: " + response.error);
   return false;
}

//+------------------------------------------------------------------+
//| Outbound pushes                                                    |
//+------------------------------------------------------------------+
bool TP_SendHeartbeat()
{
   int queuedHint = 0;
   string response;
   bool ok = TP_Post("/api/v1/bridge/heartbeat",
                     g_protocol.HeartbeatPayload(g_eaVersion, (bool)MQLInfoInteger(MQL_TRADE_ALLOWED), queuedHint),
                     response,
                     true);
   if(ok)
   {
      TP_Json parsed;
      if(parsed.Parse(response))
      {
         string status = parsed.GetString("status");
         int nextPoll = (int)parsed.GetLong("next_poll_ms", (long)g_pollIntervalMs);
         if(nextPoll > 250 && nextPoll < 60000)
            g_pollIntervalMs = nextPoll;
         if(InpVerboseLog)
            TP_Log("heartbeat accepted (" + status + ")");
      }
      g_lastHeartbeat = TimeCurrent();
   }
   return ok;
}

bool TP_SendSymbols()
{
   int total = ArraySize(g_symbols);
   if(total == 0)
      return false;

   string response;
   bool ok = false;
   for(int offset = 0; offset < total; offset += 60)
   {
      string payload = g_protocol.SymbolsPayload(g_symbols, offset, 60);
      if(!TP_Post("/api/v1/bridge/market", payload, response, true))
         return false;
      ok = true;
   }
   if(ok)
      g_lastSymbolPush = TimeCurrent();
   return ok;
}

bool TP_SendTicks()
{
   if(ArraySize(g_symbols) == 0)
      return false;
   string response;
   return TP_Post("/api/v1/bridge/market", g_protocol.TicksPayload(g_symbols), response, true);
}

bool TP_SendAccount()
{
   string response;
   bool ok = TP_Post("/api/v1/bridge/account", g_protocol.AccountPayload(), response, true);
   if(ok)
   {
      g_lastAccountPush = TimeCurrent();
      g_registeredLogin = (long)AccountInfoInteger(ACCOUNT_LOGIN);
   }
   return ok;
}

bool TP_SendPositions()
{
   string response;
   bool ok = TP_Post("/api/v1/bridge/positions", g_protocol.PositionsPayload(), response, true);
   if(ok)
      g_lastPositionPush = TimeCurrent();
   return ok;
}

bool TP_SendOrders()
{
   string response;
   return TP_Post("/api/v1/bridge/orders", g_protocol.OrdersPayload(), response, true);
}

bool TP_SendDeals()
{
   datetime to = TimeGMT() + 60;
   datetime from = to - (datetime)(30 * 86400);
   string response;
   bool ok = TP_Post("/api/v1/bridge/deals", g_protocol.DealsPayload(from, to), response, true);
   if(ok)
      g_lastHistoryPush = TimeCurrent();
   return ok;
}

bool TP_PostResult(const string commandId, const bool success, const long ticket, const double price,
                   const double volume, const int retcode, const string errorCode, const string errorMessage,
                   const string state, const string dataJson)
{
   string payload = g_protocol.ResultPayload(commandId, success, ticket, price, volume, retcode, errorCode, errorMessage, state, dataJson);
   string response;
   if(!TP_Post("/api/v1/bridge/result", payload, response, true))
   {
      // The command is remembered as executed regardless: the broker state is
      // the truth, and retrying the report would only duplicate it.
      TP_Log("could not report the result of " + commandId + " — the next positions/orders push carries the true state", true);
      return false;
   }
   return true;
}

//+------------------------------------------------------------------+
//| Resolve the broker symbol for a command                            |
//+------------------------------------------------------------------+
bool TP_SymbolForCommand(TP_Command &command, string &brokerSymbol)
{
   string requested = command.parameters.GetString("symbol");
   if(requested == "")
      requested = command.symbol;
   if(requested == "")
   {
      brokerSymbol = "";
      return false;
   }
   return TP_ResolveSymbol(requested, brokerSymbol);
}

//+------------------------------------------------------------------+
//| Command dispatch                                                   |
//+------------------------------------------------------------------+
void TP_HandleCommand(const string rawEnvelope)
{
   TP_Command command;
   if(!g_protocol.ParseAndVerify(rawEnvelope, command))
   {
      g_commandsFailed++;
      TP_Status("command refused: " + command.errorCode + " — " + command.errorMessage);
      // Report the refusal when we at least know which command it was.
      if(command.commandId != "")
         TP_PostResult(command.commandId, false, 0, 0.0, 0.0, 0, command.errorCode, command.errorMessage, "REFUSED", "");
      return;
   }

   string action = command.action;
   TP_Log("command " + action + " (" + command.commandId + ")");

   //--- terminal-side trading gates -----------------------------------
   bool tradingAction = (action == "OPEN_MARKET_ORDER" || action == "PLACE_PENDING_ORDER" ||
                         action == "MODIFY_POSITION" || action == "MODIFY_ORDER" ||
                         action == "CLOSE_POSITION" || action == "CLOSE_ALL_POSITIONS" ||
                         action == "CANCEL_ORDER" || action == "CANCEL_ALL_ORDERS");

   if(tradingAction)
   {
      if(!InpEnableTrading)
      {
         g_commandsFailed++;
         TP_PostResult(command.commandId, false, 0, 0.0, 0.0, 0, TP_ERR_TRADE_DISABLED,
                       "Trading is disabled in the EA inputs (InpEnableTrading = false) — reporting only.", "REFUSED", "");
         return;
      }
      if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED))
      {
         g_commandsFailed++;
         TP_PostResult(command.commandId, false, 0, 0.0, 0.0, 0, TP_ERR_TRADE_DISABLED,
                       "Algo trading is switched off in the MT5 toolbar (or the EA has no trade permission).", "REFUSED", "");
         return;
      }
      long currentLogin = (long)AccountInfoInteger(ACCOUNT_LOGIN);
      if(g_registeredLogin != 0 && currentLogin != g_registeredLogin)
      {
         // The terminal is logged into a different account than the one the web
         // layer believes it is trading: never touch this account on a stale
         // authorisation. Re-register and let the user re-authorise.
         g_commandsFailed++;
         TP_PostResult(command.commandId, false, 0, 0.0, 0.0, 0, TP_ERR_WRONG_ACCOUNT,
                       "The terminal switched to a different MT5 account (" + IntegerToString(currentLogin) +
                       "). Re-connect and re-authorise the account in TradePilot.", "REFUSED", "");
         TP_SendAccount();
         return;
      }
   }

   //--- data commands -------------------------------------------------
   if(action == "PING")
   {
      string data = "{\"pong\":true,\"terminal_time\":\"" + TP_Protocol::IsoNow() + "\"}";
      TP_PostResult(command.commandId, true, 0, 0.0, 0.0, 0, "", "", "OK", data);
      g_commandsExecuted++;
      return;
   }

   if(action == "GET_ACCOUNT")
   {
      string data = "{\"account\":" + g_protocol.AccountPayload() + "}";
      TP_PostResult(command.commandId, true, 0, 0.0, 0.0, 0, "", "", "OK", data);
      g_commandsExecuted++;
      return;
   }

   if(action == "GET_POSITIONS")
   {
      TP_PostResult(command.commandId, true, 0, 0.0, 0.0, 0, "", "", "OK", g_protocol.PositionsPayload());
      g_commandsExecuted++;
      return;
   }

   if(action == "GET_ORDERS")
   {
      TP_PostResult(command.commandId, true, 0, 0.0, 0.0, 0, "", "", "OK", g_protocol.OrdersPayload());
      g_commandsExecuted++;
      return;
   }

   if(action == "GET_SYMBOL_INFO")
   {
      string requested = command.parameters.GetString("symbol");
      string list[];
      string data;
      if(requested == "")
      {
         data = g_protocol.SymbolsPayload(g_symbols, 0, ArraySize(g_symbols));
      }
      else
      {
         string brokerSymbol;
         if(!TP_ResolveSymbol(requested, brokerSymbol))
         {
            g_commandsFailed++;
            TP_PostResult(command.commandId, false, 0, 0.0, 0.0, 0, TP_ERR_SYMBOL_NOT_FOUND,
                          requested + " is not available in this terminal. Add it to Market Watch in MT5 and retry.", "REFUSED", "");
            return;
         }
         ArrayResize(list, 1);
         list[0] = brokerSymbol;
         data = g_protocol.SymbolsPayload(list, 0, 1);
      }
      TP_PostResult(command.commandId, true, 0, 0.0, 0.0, 0, "", "", "OK", data);
      g_commandsExecuted++;
      return;
   }

   if(action == "GET_HISTORY")
   {
      datetime from = TP_Protocol::TP_ParseIso(command.parameters.GetString("from"));
      datetime to = TP_Protocol::TP_ParseIso(command.parameters.GetString("to"));
      if(from == 0)
         from = TimeGMT() - (datetime)(30 * 86400);
      if(to == 0)
         to = TimeGMT() + 60;
      TP_PostResult(command.commandId, true, 0, 0.0, 0.0, 0, "", "", "OK", g_protocol.DealsPayload(from, to));
      g_commandsExecuted++;
      return;
   }

   if(action == "GET_CANDLES")
   {
      string brokerSymbol;
      if(!TP_SymbolForCommand(command, brokerSymbol))
      {
         g_commandsFailed++;
         TP_PostResult(command.commandId, false, 0, 0.0, 0.0, 0, TP_ERR_SYMBOL_NOT_FOUND,
                       "The symbol for this chart request is not available in the terminal.", "REFUSED", "");
         return;
      }
      string timeframe = command.parameters.GetString("timeframe", "M15");
      int count = (int)command.parameters.GetNumber("count", 300);
      if(count < 10)
         count = 10;
      if(count > TP_MAX_RATES)
         count = TP_MAX_RATES;
      TP_PostResult(command.commandId, true, 0, 0.0, 0.0, 0, "", "", "OK",
                    g_protocol.RatesPayload(brokerSymbol, timeframe, count));
      g_commandsExecuted++;
      return;
   }

   //--- trading commands ----------------------------------------------
   TP_ExecutionOutcome outcome;
   outcome.success = false;
   outcome.ticket = 0;
   outcome.price = 0.0;
   outcome.volume = 0.0;
   outcome.retcode = 0;
   outcome.errorCode = TP_ERR_NOT_SUPPORTED;
   outcome.errorMessage = "Unsupported action " + action + ".";
   outcome.state = "REFUSED";

   if(action == "OPEN_MARKET_ORDER")
   {
      string brokerSymbol;
      if(!TP_SymbolForCommand(command, brokerSymbol))
      {
         g_commandsFailed++;
         TP_PostResult(command.commandId, false, 0, 0.0, 0.0, 0, TP_ERR_SYMBOL_NOT_FOUND,
                       "The traded symbol is not available in this terminal.", "REFUSED", "");
         return;
      }
      double volume = command.parameters.GetNumber("volume");
      double stopLoss = command.parameters.GetNumber("stop_loss");
      double takeProfit = command.parameters.GetNumber("take_profit");
      int deviation = (int)command.parameters.GetNumber("deviation_points", (double)InpDeviationPoints);
      string comment = command.parameters.GetString("comment", InpCommentPrefix + " order");
      string side = command.parameters.GetString("side", "BUY");
      StringToUpper(side);
      g_trade.OpenMarket(brokerSymbol, side, volume, stopLoss, takeProfit, deviation, comment, outcome);
   }
   else if(action == "PLACE_PENDING_ORDER")
   {
      string brokerSymbol;
      if(!TP_SymbolForCommand(command, brokerSymbol))
      {
         g_commandsFailed++;
         TP_PostResult(command.commandId, false, 0, 0.0, 0.0, 0, TP_ERR_SYMBOL_NOT_FOUND,
                       "The traded symbol is not available in this terminal.", "REFUSED", "");
         return;
      }
      string kind = command.parameters.GetString("kind");
      StringToUpper(kind);
      g_trade.PlacePending(brokerSymbol,
                           kind,
                           command.parameters.GetNumber("volume"),
                           command.parameters.GetNumber("price"),
                           command.parameters.GetNumber("stop_limit_price"),
                           command.parameters.GetNumber("stop_loss"),
                           command.parameters.GetNumber("take_profit"),
                           command.parameters.GetString("comment", InpCommentPrefix + " pending"),
                           outcome);
   }
   else if(action == "MODIFY_POSITION")
   {
      ulong ticket = (ulong)command.parameters.GetLong("ticket");
      g_trade.ModifyPosition(ticket, command.parameters.GetNumber("stop_loss"), command.parameters.GetNumber("take_profit"), outcome);
   }
   else if(action == "MODIFY_ORDER")
   {
      ulong ticket = (ulong)command.parameters.GetLong("ticket");
      g_trade.ModifyOrder(ticket, command.parameters.GetNumber("price"), command.parameters.GetNumber("stop_loss"),
                          command.parameters.GetNumber("take_profit"), outcome);
   }
   else if(action == "CLOSE_POSITION")
   {
      ulong ticket = (ulong)command.parameters.GetLong("ticket");
      int deviation = (int)command.parameters.GetNumber("deviation_points", (double)InpDeviationPoints);
      g_trade.ClosePosition(ticket, command.parameters.GetNumber("volume"), deviation, outcome);
   }
   else if(action == "CANCEL_ORDER")
   {
      ulong ticket = (ulong)command.parameters.GetLong("ticket");
      g_trade.CancelOrder(ticket, outcome);
   }
   else if(action == "CANCEL_ALL_ORDERS")
   {
      int cancelled = g_trade.CancelAllOrders(command.parameters.GetString("symbol"));
      outcome.success = true;
      outcome.errorCode = "";
      outcome.errorMessage = "";
      outcome.state = "CANCELLED";
      string data = "{\"cancelled\":" + IntegerToString(cancelled) + "}";
      TP_PostResult(command.commandId, true, 0, 0.0, 0.0, 0, "", "", "CANCELLED", data);
      g_commandsExecuted++;
      TP_SendOrders();
      return;
   }
   else if(action == "CLOSE_ALL_POSITIONS")
   {
      string confirm = command.parameters.GetString("confirm");
      string symbolFilter = command.parameters.GetString("symbol");
      long magicFilter = InpManageOnlyOwnMagic ? InpMagicNumber : 0;
      int closedCount = 0;
      double closedVolume = 0.0;
      string failures = "";
      bool ok = g_trade.CloseAllPositions(confirm, magicFilter, symbolFilter, closedCount, closedVolume, failures);
      if(!ok)
      {
         g_commandsFailed++;
         string code = (confirm != "CONFIRM CLOSE ALL") ? TP_ERR_CONFIRMATION_MISMATCH : TP_ERR_BROKER_REJECTED;
         TP_PostResult(command.commandId, false, 0, 0.0, closedVolume, 0, code, failures, "REFUSED", "");
         TP_SendPositions();
         return;
      }
      string data = "{\"closed_count\":" + IntegerToString(closedCount) +
                    ",\"closed_volume\":" + TP_Json::FormatNumber(DoubleToString(closedVolume, 8)) +
                    ",\"failures\":" + ((failures == "") ? "null" : TP_Json::Escape(failures)) + "}";
      TP_PostResult(command.commandId, true, 0, 0.0, closedVolume, 0, "", failures, "CLOSED_ALL", data);
      g_commandsExecuted++;
      TP_SendPositions();
      TP_SendAccount();
      return;
   }

   //--- report the outcome of a trading command -----------------------
   if(outcome.success)
   {
      g_commandsExecuted++;
      TP_PostResult(command.commandId, true, (long)outcome.ticket, outcome.price, outcome.volume, outcome.retcode,
                    "", "", outcome.state != "" ? outcome.state : "EXECUTED", "");
      TP_SendPositions();
      TP_SendOrders();
      TP_SendAccount();
   }
   else
   {
      g_commandsFailed++;
      TP_PostResult(command.commandId, false, 0, 0.0, outcome.volume, outcome.retcode,
                    (outcome.errorCode != "") ? outcome.errorCode : TP_ERR_BROKER_REJECTED,
                    outcome.errorMessage, "FAILED", "");
      // The broker state may still have changed (partial fill): refresh it.
      TP_SendPositions();
   }
}

//+------------------------------------------------------------------+
//| Poll the command queue                                             |
//+------------------------------------------------------------------+
void TP_PollCommands()
{
   TP_HttpResponse response;
   if(!g_http.Get("/api/v1/bridge/commands", response))
   {
      g_http.NoteFailure();
      if(InpVerboseLog)
         TP_Log("command poll failed: " + response.error);
      return;
   }
   g_http.NoteSuccess();

   string commands[];
   int count = TP_JsonArrayObjects(response.body, "commands", commands);
   for(int i = 0; i < count; i++)
      TP_HandleCommand(commands[i]);
}

//+------------------------------------------------------------------+
//| Expert initialization                                              |
//+------------------------------------------------------------------+
int OnInit()
{
   MathSrand((int)(TimeLocal() + GetTickCount()));

   string deviceId, secret;
   if(!TP_ParseDeviceToken(InpDeviceToken, deviceId, secret))
   {
      Print("[TradePilot] InpDeviceToken is missing or malformed. Expected tpd_<deviceId>_<secret> — ",
            "generate one in TradePilot → Settings → MT5 Connection.");
      TP_Status("invalid device token — see the Experts log");
      return INIT_PARAMETERS_INCORRECT;
   }
   g_tokenValid = true;

   if(InpBackendUrl == "" || StringFind(InpBackendUrl, "YOUR-BACKEND") >= 0)
   {
      Print("[TradePilot] Set InpBackendUrl to your TradePilot backend, e.g. https://trade.example.com");
      TP_Status("backend URL not configured");
      return INIT_PARAMETERS_INCORRECT;
   }
   g_urlReady = true;

   g_protocol.Configure(deviceId, secret, (long)AccountInfoInteger(ACCOUNT_LOGIN), InpClockSkewSeconds);
   g_http.Configure(InpBackendUrl, deviceId, InpDeviceToken, InpRequestTimeoutMs);
   g_trade.Init(InpMagicNumber, InpDeviationPoints);
   g_registeredLogin = (long)AccountInfoInteger(ACCOUNT_LOGIN);

   if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED))
      TP_Log("Algo trading is disabled in the toolbar — reporting works, order execution will be refused.", true);
   if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT))
      TP_Log("Expert trading is disabled for this account — order execution will be refused.", true);

   int symbolCount = TP_CollectReportableSymbols(g_symbols);
   TP_Log("reporting " + IntegerToString(symbolCount) + " symbols", true);

   TP_Status("connecting to " + InpBackendUrl + " …");
   TP_SendHeartbeat();
   TP_SendSymbols();
   TP_SendAccount();
   TP_SendPositions();
   TP_SendOrders();
   TP_SendDeals();

   g_pollIntervalMs = (InpPollIntervalMs >= 250 && InpPollIntervalMs <= 60000) ? InpPollIntervalMs : 1500;
   EventSetMillisecondTimer(g_pollIntervalMs);
   TP_Status(g_http.IsBackingOff() ? "backend unreachable — will retry automatically" : "running");
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert deinitialization                                            |
//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
   TP_Log("stopped (reason " + IntegerToString(reason) + ")");
}

//+------------------------------------------------------------------+
//| Timer: the whole bridge loop                                       |
//+------------------------------------------------------------------+
void OnTimer()
{
   if(!g_tokenValid || !g_urlReady)
      return;

   datetime now = TimeCurrent();

   // Command polling is the latency-critical part: it runs once per timer tick
   // (g_pollIntervalMs) and only pauses while the backend is in backoff.
   if(!g_http.IsBackingOff())
      TP_PollCommands();

   if(now - g_lastHeartbeat >= (datetime)MathMax(1, InpHeartbeatSeconds))
   {
      TP_SendHeartbeat();
      // A heartbeat carries the account state so the web app never shows a
      // stale balance while the terminal is alive.
      if(now - g_lastAccountPush >= (datetime)MathMax(1, InpAccountPushSeconds))
         TP_SendAccount();
   }

   if(now - g_lastPositionPush >= (datetime)MathMax(1, InpPositionPushSeconds))
   {
      TP_SendPositions();
      TP_SendOrders();
   }

   if(now - g_lastSymbolPush >= (datetime)MathMax(60, InpSymbolRefreshMinutes * 60))
   {
      TP_CollectReportableSymbols(g_symbols);
      TP_SendSymbols();
   }

   if(now - g_lastHistoryPush >= (datetime)MathMax(60, InpHistoryPushMinutes * 60))
      TP_SendDeals();

   // Ticks every second so the watchlist stays live between heartbeats.
   // Ticks on every timer tick so the watchlist stays as live as the terminal.
   TP_SendTicks();

   if(InpShowChartStatus)
      Comment("TradePilot bridge — ", g_lastStatus,
              "\naccount ", IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)), " @ ", AccountInfoString(ACCOUNT_SERVER),
              "\ncommands ", IntegerToString(g_commandsExecuted), " ok / ", IntegerToString(g_commandsFailed), " failed",
              " • last HTTP ", IntegerToString(g_lastHttpStatus),
              g_http.ConsecutiveFailures() > 0 ? " • backend failures: " + IntegerToString(g_http.ConsecutiveFailures()) : "");
}

//+------------------------------------------------------------------+
//| React to trade events immediately instead of waiting for the timer  |
//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans, const MqlTradeRequest &request, const MqlTradeResult &result)
{
   if(trans.type == TRADE_TRANSACTION_DEAL_ADD || trans.type == TRADE_TRANSACTION_ORDER_ADD ||
      trans.type == TRADE_TRANSACTION_ORDER_DELETE || trans.type == TRADE_TRANSACTION_POSITION)
   {
      TP_SendPositions();
      TP_SendOrders();
      TP_SendAccount();
   }
}
