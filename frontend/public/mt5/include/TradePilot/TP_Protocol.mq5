//+------------------------------------------------------------------+
//|                                           TP_Protocol.mq5        |
//|  TradePilot — bridge protocol implementation on the MT5 side.     |
//|                                                                  |
//|  Inbound  (web → EA): signed command envelopes, verified with      |
//|  HMAC-SHA256 over the canonical payload, plus a freshness window,  |
//|  a single-use nonce and an executed-command-id list (replay and    |
//|  duplicate protection).                                           |
//|                                                                  |
//|  Outbound (EA → web): heartbeat, account, symbol specs, ticks,     |
//|  positions, pending orders, deal history and execution results —   |
//|  all wrapped in the same envelope shape the backend validates.     |
//+------------------------------------------------------------------+
#property copyright "TradePilot"
#property version   "1.00"

#ifndef TP_PROTOCOL_MQH
#define TP_PROTOCOL_MQH

#include "TP_Json.mq5"
#include "TP_Sha256.mq5"
#include "TP_Symbols.mq5"

#define TP_PROTOCOL_VERSION "1.0.0"
#define TP_MAX_RATES        1000
#define TP_COMMAND_MEMORY   256

//--- error codes mirrored from the backend ----------------------------
#define TP_ERR_MT5_OFFLINE        "MT5_OFFLINE"
#define TP_ERR_SIGNATURE          "SIGNATURE_INVALID"
#define TP_ERR_REPLAY             "REPLAY_DETECTED"
#define TP_ERR_STALE_COMMAND      "COMMAND_EXPIRED"
#define TP_ERR_CLOCK_SKEW         "MT5_CLOCK_SKEW"
#define TP_ERR_WRONG_ACCOUNT      "ACCOUNT_MISMATCH"
#define TP_ERR_MALFORMED          "MALFORMED_COMMAND"

struct TP_Command
{
   string commandId;
   string timestamp;
   string userId;
   string accountId;
   string symbol;
   string action;
   string idempotencyKey;
   string nonce;
   string signature;
   string protocolVersion;
   string parametersCanonical;
   TP_Json document;
   TP_Json parameters;
   bool    parsed;
   string  errorCode;
   string  errorMessage;
};

class TP_Protocol
{
private:
   string m_deviceId;
   string m_secret;
   long   m_accountLogin;
   int    m_clockSkewSeconds;
   long   m_sequence;
   string m_recentNonces[];
   string m_recentCommands[];
   int    m_nonceCount;
   int    m_nonceCursor;
   int    m_commandCount;
   int    m_commandCursor;

   bool Seen(const string needle, const string &haystack[], const int count)
   {
      for(int i = 0; i < count; i++)
         if(haystack[i] == needle)
            return true;
      return false;
   }

   //--- fixed-size ring buffer of recently seen values ----------------
   void Remember(string &memory[], int &count, int &cursor, const string value)
   {
      if(count < TP_COMMAND_MEMORY)
      {
         ArrayResize(memory, count + 1);
         memory[count] = value;
         count++;
         return;
      }
      ArrayResize(memory, TP_COMMAND_MEMORY);
      memory[cursor] = value;
      cursor = (cursor + 1) % TP_COMMAND_MEMORY;
   }

   bool CheckFreshness(const string isoTimestamp, string &errorMessage)
   {
      datetime sent = TP_ParseIso(isoTimestamp);
      if(sent == 0)
      {
         errorMessage = "Command timestamp is not a valid ISO-8601 UTC value.";
         return false;
      }
      long drift = (long)sent - (long)TimeGMT();
      if(MathAbs(drift) > (long)m_clockSkewSeconds)
      {
         errorMessage = "Command timestamp differs from the terminal clock by " + IntegerToString((int)drift) +
                        " seconds (limit " + IntegerToString(m_clockSkewSeconds) + "). Check the MT5 machine clock / NTP.";
         return false;
      }
      return true;
   }

public:
   TP_Protocol()
   {
      m_deviceId = "";
      m_secret = "";
      m_accountLogin = 0;
      m_clockSkewSeconds = 180;
      m_sequence = 0;
      m_nonceCount = 0;
      m_nonceCursor = 0;
      m_commandCount = 0;
      m_commandCursor = 0;
   }

   void Configure(const string deviceId, const string secret, const long accountLogin, const int clockSkewSeconds)
   {
      m_deviceId = deviceId;
      m_secret = secret;
      m_accountLogin = accountLogin;
      m_clockSkewSeconds = (clockSkewSeconds > 0) ? clockSkewSeconds : 180;
   }

   string DeviceId() { return m_deviceId; }
   long   NextSequence() { m_sequence++; return m_sequence; }
   void   SetSequence(const long sequence) { if(sequence > m_sequence) m_sequence = sequence; }

   //+---------------------------------------------------------------+
   //| Time helpers                                                   |
   //+---------------------------------------------------------------+
   static string IsoNow()
   {
      return TP_IsoFromDatetime(TimeGMT());
   }

   static string TP_IsoFromDatetime(const datetime value)
   {
      MqlDateTime parts;
      TimeToStruct(value, parts);
      return StringFormat("%04d-%02d-%02dT%02d:%02d:%02d.000Z",
                          parts.year, parts.mon, parts.day, parts.hour, parts.min, parts.sec);
   }

   //--- "2026-10-08T17:00:00.000Z" → datetime (UTC) -----------------
   static datetime TP_ParseIso(const string iso)
   {
      string text = iso;
      StringReplace(text, "T", " ");
      StringReplace(text, "-", ".");
      if(StringLen(text) < 19)
         return 0;
      return StringToTime(StringSubstr(text, 0, 19));
   }

   static datetime TP_AddDays(const datetime value, const int days)
   {
      return value + (datetime)(days * 86400);
   }

   //+---------------------------------------------------------------+
   //| Verify one command envelope                                    |
   //+---------------------------------------------------------------+
   bool ParseAndVerify(const string rawEnvelope, TP_Command &command)
   {
      command.parsed = false;
      command.errorCode = "";
      command.errorMessage = "";

      if(!command.document.Parse(rawEnvelope))
      {
         command.errorCode = TP_ERR_MALFORMED;
         command.errorMessage = "The command envelope is not valid JSON: " + command.document.Error();
         return false;
      }

      command.commandId        = command.document.GetString("command_id");
      command.timestamp        = command.document.GetString("timestamp");
      command.userId           = command.document.GetString("user_id");
      command.accountId        = command.document.GetString("account_id");
      command.symbol           = command.document.GetString("symbol");
      command.action           = command.document.GetString("action");
      command.idempotencyKey   = command.document.GetString("idempotency_key");
      command.nonce            = command.document.GetString("nonce");
      command.signature        = command.document.GetString("signature");
      command.protocolVersion  = command.document.GetString("protocol_version");
      command.parametersCanonical = command.document.CanonicalValue("parameters");

      if(command.commandId == "" || command.action == "" || command.signature == "")
      {
         command.errorCode = TP_ERR_MALFORMED;
         command.errorMessage = "The command envelope is missing command_id, action or signature.";
         return false;
      }

      if(command.protocolVersion != "" && command.protocolVersion != TP_PROTOCOL_VERSION)
      {
         command.errorCode = TP_ERR_MALFORMED;
         command.errorMessage = "Unsupported bridge protocol version " + command.protocolVersion +
                                " (this EA speaks " + TP_PROTOCOL_VERSION + ").";
         return false;
      }

      //--- replay protection: nonce and command id must be new --------
      if(Seen(command.nonce, m_recentNonces, m_nonceCount))
      {
         command.errorCode = TP_ERR_REPLAY;
         command.errorMessage = "This command nonce has already been used on this terminal.";
         return false;
      }
      if(Seen(command.commandId, m_recentCommands, m_commandCount))
      {
         command.errorCode = TP_ERR_REPLAY;
         command.errorMessage = "Command " + command.commandId + " has already been executed by this terminal (idempotent replay).";
         return false;
      }

      if(!CheckFreshness(command.timestamp, command.errorMessage))
      {
         command.errorCode = TP_ERR_CLOCK_SKEW;
         return false;
      }

      //--- signature over the canonical payload ----------------------
      string canonical = command.commandId + "|" + command.timestamp + "|" + command.userId + "|" +
                         command.accountId + "|" + command.symbol + "|" + command.action + "|" +
                         command.parametersCanonical + "|" + command.idempotencyKey + "|" + command.nonce + "|" +
                         TP_PROTOCOL_VERSION;

      string expected = "";
      if(!TP_HmacSha256OfStrings(m_secret, canonical, expected))
      {
         command.errorCode = TP_ERR_SIGNATURE;
         command.errorMessage = "Could not compute the command signature inside the terminal.";
         return false;
      }
      if(!TP_HexEqual(expected, command.signature))
      {
         command.errorCode = TP_ERR_SIGNATURE;
         command.errorMessage = "Command signature verification failed — the command was not signed with this device's secret.";
         return false;
      }

      if(!command.parameters.Parse(command.parametersCanonical))
      {
         command.errorCode = TP_ERR_MALFORMED;
         command.errorMessage = "Command parameters are not valid JSON.";
         return false;
      }

      Remember(m_recentNonces, m_nonceCount, m_nonceCursor, command.nonce);
      Remember(m_recentCommands, m_commandCount, m_commandCursor, command.commandId);
      command.parsed = true;
      return true;
   }

   //+---------------------------------------------------------------+
   //| Outbound envelope                                              |
   //+---------------------------------------------------------------+
   string Envelope(const string payloadJson)
   {
      string json = "{";
      json += "\"device_id\":" + TP_Json::Escape(m_deviceId);
      json += ",\"device_token\":" + TP_Json::Escape(m_secret);
      json += ",\"protocol_version\":\"" + TP_PROTOCOL_VERSION + "\"";
      json += ",\"sent_at\":\"" + IsoNow() + "\"";
      json += ",\"sequence\":" + IntegerToString((long)NextSequence());
      json += ",\"payload\":" + payloadJson;
      json += "}";
      return json;
   }

   //+---------------------------------------------------------------+
   //| Payload builders                                               |
   //+---------------------------------------------------------------+
   string HeartbeatPayload(const string eaVersion, const bool eaTradeAllowed, const int queuedHint)
   {
      string json = "{";
      json += "\"device_id\":" + TP_Json::Escape(m_deviceId);
      json += ",\"sequence\":" + IntegerToString((long)m_sequence + 1);
      json += ",\"account\":\"" + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN)) + "\"";
      json += ",\"server\":" + TP_Json::Escape(AccountInfoString(ACCOUNT_SERVER));
      json += ",\"timestamp\":\"" + IsoNow() + "\"";
      json += ",\"terminal_connected\":" + ((TerminalInfoInteger(TERMINAL_CONNECTED) != 0) ? "true" : "false");
      json += ",\"trade_allowed\":" + ((AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) != 0) ? "true" : "false");
      json += ",\"ea_trade_allowed\":" + (eaTradeAllowed ? "true" : "false");
      json += ",\"algo_trading_enabled\":" + ((TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) != 0) ? "true" : "false");
      json += ",\"ping_ms\":" + IntegerToString(0);
      json += ",\"terminal_build\":" + TP_Json::Escape(IntegerToString((int)TerminalInfoInteger(TERMINAL_BUILD)));
      json += ",\"ea_version\":" + TP_Json::Escape(eaVersion);
      json += ",\"queued_commands\":" + IntegerToString(queuedHint);
      json += "}";
      return json;
   }

   string AccountPayload()
   {
      double marginLevel = 0.0;
      double margin = AccountInfoDouble(ACCOUNT_MARGIN);
      if(margin > 0.0)
         marginLevel = AccountInfoDouble(ACCOUNT_EQUITY) / margin * 100.0;

      string json = "{";
      json += "\"login\":" + IntegerToString((long)AccountInfoInteger(ACCOUNT_LOGIN));
      json += ",\"server\":" + TP_Json::Escape(AccountInfoString(ACCOUNT_SERVER));
      json += ",\"currency\":" + TP_Json::Escape(AccountInfoString(ACCOUNT_CURRENCY));
      json += ",\"leverage\":" + IntegerToString((int)AccountInfoInteger(ACCOUNT_LEVERAGE));
      json += ",\"balance\":" + TP_Json::FormatNumber(DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 8));
      json += ",\"equity\":" + TP_Json::FormatNumber(DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 8));
      json += ",\"margin\":" + TP_Json::FormatNumber(DoubleToString(margin, 8));
      json += ",\"free_margin\":" + TP_Json::FormatNumber(DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 8));
      json += ",\"margin_level\":" + TP_Json::FormatNumber(DoubleToString(marginLevel, 8));
      json += ",\"profit\":" + TP_Json::FormatNumber(DoubleToString(AccountInfoDouble(ACCOUNT_PROFIT), 8));
      json += ",\"trade_allowed\":" + ((AccountInfoInteger(ACCOUNT_TRADE_ALLOWED) != 0) ? "true" : "false");
      json += ",\"trade_expert\":" + ((AccountInfoInteger(ACCOUNT_TRADE_EXPERT) != 0) ? "true" : "false");
      json += ",\"timestamp\":\"" + IsoNow() + "\"";
      json += "}";
      return json;
   }

   string SymbolsPayload(const string &symbols[], const int fromIndex, const int maxCount)
   {
      string json = "{\"symbols\":[";
      int total = ArraySize(symbols);
      int emitted = 0;
      for(int i = fromIndex; i < total && emitted < maxCount; i++)
      {
         if(emitted > 0)
            json += ",";
         json += TP_SymbolPayload(symbols[i]);
         emitted++;
      }
      json += "]}";
      return json;
   }

   string TicksPayload(const string &symbols[])
   {
      string json = "{\"ticks\":[";
      int total = ArraySize(symbols);
      int emitted = 0;
      for(int i = 0; i < total; i++)
      {
         MqlTick tick;
         if(!SymbolInfoTick(symbols[i], tick))
            continue;
         if(tick.bid <= 0.0 && tick.ask <= 0.0)
            continue;
         if(emitted > 0)
            json += ",";
         double point = SymbolInfoDouble(symbols[i], SYMBOL_POINT);
         double spreadPoints = (point > 0.0) ? (tick.ask - tick.bid) / point : 0.0;
         json += "{";
         json += "\"symbol\":" + TP_Json::Escape(symbols[i]);
         json += ",\"bid\":" + TP_Json::FormatNumber(DoubleToString(tick.bid, 10));
         json += ",\"ask\":" + TP_Json::FormatNumber(DoubleToString(tick.ask, 10));
         json += ",\"last\":" + TP_Json::FormatNumber(DoubleToString(tick.last, 10));
         json += ",\"spread_points\":" + TP_Json::FormatNumber(DoubleToString(spreadPoints, 4));
         json += ",\"time\":\"" + TP_IsoFromDatetime(tick.time) + "\"";
         double dayHigh = iHigh(symbols[i], PERIOD_D1, 0);
         double dayLow = iLow(symbols[i], PERIOD_D1, 0);
         double dayOpen = iOpen(symbols[i], PERIOD_D1, 0);
         if(dayHigh > 0.0)
            json += ",\"day_high\":" + TP_Json::FormatNumber(DoubleToString(dayHigh, 10));
         if(dayLow > 0.0)
            json += ",\"day_low\":" + TP_Json::FormatNumber(DoubleToString(dayLow, 10));
         if(dayOpen > 0.0)
            json += ",\"day_open\":" + TP_Json::FormatNumber(DoubleToString(dayOpen, 10));
         json += "}";
         emitted++;
      }
      json += "]}";
      return json;
   }

   string PositionsPayload()
   {
      string json = "{\"positions\":[";
      int total = PositionsTotal();
      int emitted = 0;
      for(int i = 0; i < total; i++)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0)
            continue;
         if(emitted > 0)
            json += ",";
         json += "{";
         json += "\"ticket\":" + IntegerToString((long)ticket);
         json += ",\"symbol\":" + TP_Json::Escape(PositionGetString(POSITION_SYMBOL));
         json += ",\"type\":" + IntegerToString((int)PositionGetInteger(POSITION_TYPE));
         json += ",\"volume\":" + TP_Json::FormatNumber(DoubleToString(PositionGetDouble(POSITION_VOLUME), 8));
         json += ",\"open_price\":" + TP_Json::FormatNumber(DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN), 10));
         json += ",\"current_price\":" + TP_Json::FormatNumber(DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT), 10));
         json += ",\"stop_loss\":" + TP_Json::FormatNumber(DoubleToString(PositionGetDouble(POSITION_SL), 10));
         json += ",\"take_profit\":" + TP_Json::FormatNumber(DoubleToString(PositionGetDouble(POSITION_TP), 10));
         json += ",\"profit\":" + TP_Json::FormatNumber(DoubleToString(PositionGetDouble(POSITION_PROFIT), 8));
         json += ",\"swap\":" + TP_Json::FormatNumber(DoubleToString(PositionGetDouble(POSITION_SWAP), 8));
         json += ",\"commission\":0";
         json += ",\"magic\":" + IntegerToString((long)PositionGetInteger(POSITION_MAGIC));
         json += ",\"comment\":" + TP_Json::Escape(PositionGetString(POSITION_COMMENT));
         json += ",\"open_time\":\"" + TP_IsoFromDatetime((datetime)PositionGetInteger(POSITION_TIME)) + "\"";
         json += "}";
         emitted++;
      }
      json += "]}";
      return json;
   }

   string OrdersPayload()
   {
      string json = "{\"orders\":[";
      int total = OrdersTotal();
      int emitted = 0;
      for(int i = 0; i < total; i++)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0)
            continue;
         if(emitted > 0)
            json += ",";
         json += "{";
         json += "\"ticket\":" + IntegerToString((long)ticket);
         json += ",\"symbol\":" + TP_Json::Escape(OrderGetString(ORDER_SYMBOL));
         json += ",\"type\":" + IntegerToString((int)OrderGetInteger(ORDER_TYPE));
         json += ",\"volume\":" + TP_Json::FormatNumber(DoubleToString(OrderGetDouble(ORDER_VOLUME_CURRENT), 8));
         json += ",\"price\":" + TP_Json::FormatNumber(DoubleToString(OrderGetDouble(ORDER_PRICE_OPEN), 10));
         json += ",\"stop_limit_price\":" + TP_Json::FormatNumber(DoubleToString(OrderGetDouble(ORDER_PRICE_STOPLIMIT), 10));
         json += ",\"stop_loss\":" + TP_Json::FormatNumber(DoubleToString(OrderGetDouble(ORDER_SL), 10));
         json += ",\"take_profit\":" + TP_Json::FormatNumber(DoubleToString(OrderGetDouble(ORDER_TP), 10));
         json += ",\"expiration\":\"" + TP_IsoFromDatetime((datetime)OrderGetInteger(ORDER_TIME_EXPIRATION)) + "\"";
         json += ",\"state\":" + IntegerToString((int)OrderGetInteger(ORDER_STATE));
         json += ",\"magic\":" + IntegerToString((long)OrderGetInteger(ORDER_MAGIC));
         json += ",\"comment\":" + TP_Json::Escape(OrderGetString(ORDER_COMMENT));
         json += ",\"setup_time\":\"" + TP_IsoFromDatetime((datetime)OrderGetInteger(ORDER_TIME_SETUP)) + "\"";
         json += "}";
         emitted++;
      }
      json += "]}";
      return json;
   }

   //--- deals between two UTC datetimes (used for live history sync) ---
   string DealsPayload(const datetime from, const datetime to)
   {
      string json = "{\"deals\":[";
      if(!HistorySelect(from, to))
      {
         json += "]}";
         return json;
      }
      int total = HistoryDealsTotal();
      int emitted = 0;
      for(int i = 0; i < total; i++)
      {
         ulong ticket = HistoryDealGetTicket(i);
         if(ticket == 0)
            continue;
         long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
         if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_INOUT && entry != DEAL_ENTRY_IN)
            continue;
         if(emitted > 0)
            json += ",";
         json += "{";
         json += "\"ticket\":" + IntegerToString((long)ticket);
         json += ",\"position_id\":" + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_POSITION_ID));
         json += ",\"symbol\":" + TP_Json::Escape(HistoryDealGetString(ticket, DEAL_SYMBOL));
         json += ",\"type\":" + IntegerToString((int)HistoryDealGetInteger(ticket, DEAL_TYPE));
         json += ",\"entry\":" + IntegerToString((int)entry);
         json += ",\"volume\":" + TP_Json::FormatNumber(DoubleToString(HistoryDealGetDouble(ticket, DEAL_VOLUME), 8));
         json += ",\"price\":" + TP_Json::FormatNumber(DoubleToString(HistoryDealGetDouble(ticket, DEAL_PRICE), 10));
         json += ",\"commission\":" + TP_Json::FormatNumber(DoubleToString(HistoryDealGetDouble(ticket, DEAL_COMMISSION), 8));
         json += ",\"swap\":" + TP_Json::FormatNumber(DoubleToString(HistoryDealGetDouble(ticket, DEAL_SWAP), 8));
         json += ",\"profit\":" + TP_Json::FormatNumber(DoubleToString(HistoryDealGetDouble(ticket, DEAL_PROFIT), 8));
         json += ",\"time\":\"" + TP_IsoFromDatetime((datetime)HistoryDealGetInteger(ticket, DEAL_TIME)) + "\"";
         json += ",\"magic\":" + IntegerToString((long)HistoryDealGetInteger(ticket, DEAL_MAGIC));
         json += ",\"comment\":" + TP_Json::Escape(HistoryDealGetString(ticket, DEAL_COMMENT));
         json += "}";
         emitted++;
      }
      json += "]}";
      return json;
   }

   //--- OHLC series for the chart (GET_CANDLES) ----------------------
   string RatesPayload(const string symbol, const string timeframe, const int count)
   {
      ENUM_TIMEFRAMES period = TP_TimeframeToPeriod(timeframe);
      MqlRates rates[];
      int copied = CopyRates(symbol, period, 0, count, rates);
      string json = "{\"rates\":[";
      if(copied > 0)
      {
         for(int i = 0; i < copied && i < TP_MAX_RATES; i++)
         {
            if(i > 0)
               json += ",";
            json += "{";
            json += "\"time\":\"" + TP_IsoFromDatetime(rates[i].time) + "\"";
            json += ",\"open\":" + TP_Json::FormatNumber(DoubleToString(rates[i].open, 10));
            json += ",\"high\":" + TP_Json::FormatNumber(DoubleToString(rates[i].high, 10));
            json += ",\"low\":" + TP_Json::FormatNumber(DoubleToString(rates[i].low, 10));
            json += ",\"close\":" + TP_Json::FormatNumber(DoubleToString(rates[i].close, 10));
            json += ",\"volume\":" + IntegerToString((long)rates[i].tick_volume);
            json += "}";
         }
      }
      json += "]}";
      return json;
   }

   static ENUM_TIMEFRAMES TP_TimeframeToPeriod(const string timeframe)
   {
      if(timeframe == "M1")  return PERIOD_M1;
      if(timeframe == "M5")  return PERIOD_M5;
      if(timeframe == "M15") return PERIOD_M15;
      if(timeframe == "M30") return PERIOD_M30;
      if(timeframe == "H1")  return PERIOD_H1;
      if(timeframe == "H4")  return PERIOD_H4;
      if(timeframe == "D1")  return PERIOD_D1;
      if(timeframe == "W1")  return PERIOD_W1;
      return PERIOD_M15;
   }

   static string TP_PeriodToTimeframe(const ENUM_TIMEFRAMES period)
   {
      switch(period)
      {
         case PERIOD_M1:  return "M1";
         case PERIOD_M5:  return "M5";
         case PERIOD_M15: return "M15";
         case PERIOD_M30: return "M30";
         case PERIOD_H1:  return "H1";
         case PERIOD_H4:  return "H4";
         case PERIOD_D1:  return "D1";
         case PERIOD_W1:  return "W1";
      }
      return "M15";
   }

   //--- execution result body (POST /bridge/result) -------------------
   string ResultPayload(const string commandId, const bool success, const long brokerTicket, const double price,
                        const double volume, const int retcode, const string errorCode, const string errorMessage,
                        const string state, const string dataJson)
   {
      string json = "{";
      json += "\"command_id\":" + TP_Json::Escape(commandId);
      json += ",\"success\":" + (success ? "true" : "false");
      json += ",\"broker_ticket\":" + ((brokerTicket > 0) ? IntegerToString(brokerTicket) : "null");
      json += ",\"execution_price\":" + ((price > 0.0) ? TP_Json::FormatNumber(DoubleToString(price, 10)) : "null");
      json += ",\"volume\":" + ((volume > 0.0) ? TP_Json::FormatNumber(DoubleToString(volume, 8)) : "null");
      json += ",\"retcode\":" + ((retcode != 0) ? IntegerToString(retcode) : "null");
      json += ",\"error_code\":" + ((errorCode != "") ? TP_Json::Escape(errorCode) : "null");
      json += ",\"error_message\":" + ((errorMessage != "") ? TP_Json::Escape(errorMessage) : "null");
      json += ",\"timestamp\":\"" + IsoNow() + "\"";
      json += ",\"state\":" + ((state != "") ? TP_Json::Escape(state) : "null");
      json += ",\"data\":" + ((dataJson != "") ? dataJson : "null");
      json += "}";
      return json;
   }
};

#endif // TP_PROTOCOL_MQH
//+------------------------------------------------------------------+
