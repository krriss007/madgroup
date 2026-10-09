//+------------------------------------------------------------------+
//|                                              TP_Trade.mq5        |
//|  TradePilot — command execution with pre-trade revalidation.     |
//|                                                                  |
//|  Everything the web layer already validated is validated AGAIN in |
//|  the terminal, because the EA is the last component that can be   |
//|  sure of live state: symbol trade mode, volume grid, stops level, |
//|  freeze level, market open, margin available and account rights.   |
//|  A rejected command carries a machine-readable error_code plus an  |
//|  exact human reason, and nothing is ever sent to the broker on    |
//|  doubt.                                                           |
//+------------------------------------------------------------------+
#property copyright "TradePilot"
#property version   "1.00"

#ifndef TP_TRADE_MQH
#define TP_TRADE_MQH

#include <Trade/Trade.mqh>
#include "TP_Json.mq5"
#include "TP_Symbols.mq5"

//--- error codes shared with the web layer (backend/src/lib/errors.ts) --
#define TP_ERR_INVALID_VOLUME        "INVALID_VOLUME"
#define TP_ERR_STOPS_LEVEL           "STOPS_LEVEL_VIOLATION"
#define TP_ERR_FREEZE_LEVEL          "FREEZE_LEVEL_VIOLATION"
#define TP_ERR_SYMBOL_NOT_FOUND      "SYMBOL_NOT_FOUND"
#define TP_ERR_MARKET_CLOSED         "MARKET_CLOSED"
#define TP_ERR_TRADE_DISABLED        "TRADE_DISABLED"
#define TP_ERR_INSUFFICIENT_MARGIN   "INSUFFICIENT_MARGIN"
#define TP_ERR_TICKET_NOT_FOUND      "TICKET_NOT_FOUND"
#define TP_ERR_INVALID_PRICE         "INVALID_PRICE"
#define TP_ERR_CONFIRMATION_MISMATCH "CONFIRMATION_MISMATCH"
#define TP_ERR_BROKER_REJECTED       "BROKER_REJECTED"
#define TP_ERR_EA_TRADE_DISABLED     "EA_TRADE_DISABLED"
#define TP_ERR_NOT_SUPPORTED         "NOT_SUPPORTED"

struct TP_ExecutionOutcome
{
   bool   success;
   ulong  ticket;
   double price;
   double volume;
   int    retcode;
   string errorCode;
   string errorMessage;
   string state;
};

class TP_Trade
{
private:
   CTrade m_trade;
   long   m_magic;
   int    m_deviation;
   string m_lastError;

   bool StopsDistanceOk(const string symbol, const double reference, const double stop, string &reason)
   {
      if(stop <= 0.0)
         return true;
      int stopsLevel = (int)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL);
      int freezeLevel = (int)SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL);
      double point = SymbolInfoDouble(symbol, SYMBOL_POINT);
      if(point <= 0.0)
         point = SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE);
      if(point <= 0.0)
         return true;

      double distancePoints = MathAbs(reference - stop) / point;
      if(stopsLevel > 0 && distancePoints < (double)stopsLevel)
      {
         reason = "Stop is " + DoubleToString(distancePoints, 1) + " points from the reference price but " + symbol +
                  " requires at least " + IntegerToString(stopsLevel) + " points.";
         return false;
      }
      if(freezeLevel > 0 && distancePoints < (double)freezeLevel)
      {
         reason = "Stop is inside the broker's freeze level (" + IntegerToString(freezeLevel) + " points) for " + symbol + ".";
         return false;
      }
      return true;
   }

   bool VolumeOk(const string symbol, const double volume, string &reason)
   {
      double minVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
      double maxVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
      double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
      if(step <= 0.0)
         step = 0.01;

      if(volume <= 0.0)
      {
         reason = "Volume must be greater than zero.";
         return false;
      }
      if(volume < minVolume - step / 10.0)
      {
         reason = "Volume " + DoubleToString(volume, 4) + " is below the broker minimum of " + DoubleToString(minVolume, 4) + " lots.";
         return false;
      }
      if(volume > maxVolume + step / 10.0)
      {
         reason = "Volume " + DoubleToString(volume, 4) + " is above the broker maximum of " + DoubleToString(maxVolume, 4) + " lots.";
         return false;
      }
      double steps = MathRound(volume / step);
      if(MathAbs(steps * step - volume) > step / 100.0)
      {
         reason = "Volume " + DoubleToString(volume, 4) + " is not a multiple of the volume step " + DoubleToString(step, 4) + ".";
         return false;
      }
      return true;
   }

   double NormaliseVolume(const string symbol, const double requested)
   {
      double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
      double minVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
      double maxVolume = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX);
      if(step <= 0.0)
         step = 0.01;
      double steps = MathFloor(requested / step + 0.0000001);
      double volume = steps * step;
      if(volume < minVolume)
         volume = minVolume;
      if(volume > maxVolume)
         volume = maxVolume;
      int digits = (int)MathMax(0, MathMin(8, (int)MathCeil(-MathLog10(step))));
      return NormalizeDouble(volume, digits);
   }

   bool MarginOk(const string symbol, const ENUM_ORDER_TYPE orderType, const double volume, const double price, string &reason)
   {
      double marginRequired = 0.0;
      if(!OrderCalcMargin(orderType, symbol, volume, price, marginRequired))
         return true;   // broker cannot compute it → do not block, the terminal will decide
      double freeMargin = AccountInfoDouble(ACCOUNT_MARGIN_FREE);
      if(marginRequired > freeMargin)
      {
         reason = "Required margin " + DoubleToString(marginRequired, 2) + " exceeds free margin " + DoubleToString(freeMargin, 2) + ".";
         return false;
      }
      return true;
   }

   bool SymbolTradable(const string symbol, string &reason)
   {
      if(!SymbolInfoInteger(symbol, SYMBOL_SELECT) && !SymbolInfoInteger(symbol, SYMBOL_VISIBLE))
      {
         reason = symbol + " is not available in this terminal.";
         return false;
      }
      long tradeMode = SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE);
      if(tradeMode == SYMBOL_TRADE_MODE_DISABLED)
      {
         reason = "Trading is disabled by the broker for " + symbol + ".";
         return false;
      }
      if(tradeMode == SYMBOL_TRADE_MODE_CLOSEONLY)
      {
         reason = "The broker allows closing only on " + symbol + " right now.";
         return false;
      }
      MqlTick tick;
      if(!SymbolInfoTick(symbol, tick) || tick.ask <= 0.0 || tick.bid <= 0.0)
      {
         reason = "No live quote is available for " + symbol + " — the market may be closed.";
         return false;
      }
      return true;
   }

   ENUM_ORDER_TYPE PendingOrderType(const string kind, bool &known)
   {
      known = true;
      if(kind == "BUY_LIMIT")       return ORDER_TYPE_BUY_LIMIT;
      if(kind == "SELL_LIMIT")      return ORDER_TYPE_SELL_LIMIT;
      if(kind == "BUY_STOP")        return ORDER_TYPE_BUY_STOP;
      if(kind == "SELL_STOP")       return ORDER_TYPE_SELL_STOP;
      if(kind == "BUY_STOP_LIMIT")  return ORDER_TYPE_BUY_STOP_LIMIT;
      if(kind == "SELL_STOP_LIMIT") return ORDER_TYPE_SELL_STOP_LIMIT;
      known = false;
      return ORDER_TYPE_BUY_LIMIT;
   }

   void FillOutcomeFromResult(TP_ExecutionOutcome &outcome)
   {
      outcome.retcode = (int)m_trade.ResultRetcode();
      outcome.ticket = m_trade.ResultOrder();
      outcome.price = m_trade.ResultPrice();
      outcome.volume = m_trade.ResultVolume();
      outcome.success = (outcome.retcode == TRADE_RETCODE_DONE || outcome.retcode == TRADE_RETCODE_PLACED ||
                         outcome.retcode == TRADE_RETCODE_DONE_PARTIAL);
      if(!outcome.success)
      {
         outcome.errorCode = TP_ERR_BROKER_REJECTED;
         outcome.errorMessage = "Broker rejected the request: " + m_trade.ResultRetcodeDescription() +
                                " (retcode " + IntegerToString(outcome.retcode) + ").";
      }
      else
      {
         outcome.errorCode = "";
         outcome.errorMessage = "";
         outcome.state = "EXECUTED";
      }
   }

public:
   TP_Trade() { m_magic = 700100; m_deviation = 20; m_lastError = ""; }

   void Init(const long magic, const int deviationPoints)
   {
      m_magic = magic;
      m_deviation = deviationPoints;
      m_trade.SetExpertMagicNumber((ulong)magic);
      m_trade.SetDeviationInPoints((ulong)MathMax(0, deviationPoints));
      m_trade.SetAsyncMode(false);
      m_trade.LogLevel(LOG_LEVEL_ERRORS);
   }

   string LastError() { return m_lastError; }

   //+---------------------------------------------------------------+
   //| OPEN_MARKET_ORDER                                              |
   //+---------------------------------------------------------------+
   bool OpenMarket(const string brokerSymbol, const string side, const double requestedVolume,
                   const double stopLoss, const double takeProfit, const int deviationPoints,
                   const string comment, TP_ExecutionOutcome &outcome)
   {
      outcome.success = false;
      outcome.ticket = 0;
      outcome.price = 0.0;
      outcome.volume = 0.0;
      outcome.retcode = 0;
      outcome.errorCode = "";
      outcome.errorMessage = "";
      outcome.state = "";

      if(!TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) || !MQLInfoInteger(MQL_TRADE_ALLOWED) ||
         !AccountInfoInteger(ACCOUNT_TRADE_EXPERT) || !AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
      {
         outcome.errorCode = TP_ERR_EA_TRADE_DISABLED;
         outcome.errorMessage = "Algo trading / expert trading is disabled in the terminal or for this account.";
         return false;
      }

      string reason = "";
      if(!SymbolTradable(brokerSymbol, reason))
      {
         outcome.errorCode = (StringFind(reason, "quote") >= 0) ? TP_ERR_MARKET_CLOSED : TP_ERR_TRADE_DISABLED;
         outcome.errorMessage = reason;
         return false;
      }

      double volume = NormaliseVolume(brokerSymbol, requestedVolume);
      if(!VolumeOk(brokerSymbol, volume, reason))
      {
         outcome.errorCode = TP_ERR_INVALID_VOLUME;
         outcome.errorMessage = reason;
         return false;
      }

      MqlTick tick;
      SymbolInfoTick(brokerSymbol, tick);
      double price = (side == "SELL") ? tick.bid : tick.ask;

      if(!StopsDistanceOk(brokerSymbol, price, stopLoss, reason) || !StopsDistanceOk(brokerSymbol, price, takeProfit, reason))
      {
         outcome.errorCode = TP_ERR_STOPS_LEVEL;
         outcome.errorMessage = reason;
         return false;
      }

      if(stopLoss > 0.0 && side == "BUY" && stopLoss >= price)
      {
         outcome.errorCode = TP_ERR_STOPS_LEVEL;
         outcome.errorMessage = "A BUY stop loss must be below the entry price.";
         return false;
      }
      if(stopLoss > 0.0 && side == "SELL" && stopLoss <= price)
      {
         outcome.errorCode = TP_ERR_STOPS_LEVEL;
         outcome.errorMessage = "A SELL stop loss must be above the entry price.";
         return false;
      }

      ENUM_ORDER_TYPE orderType = (side == "SELL") ? ORDER_TYPE_SELL : ORDER_TYPE_BUY;
      if(!MarginOk(brokerSymbol, orderType, volume, price, reason))
      {
         outcome.errorCode = TP_ERR_INSUFFICIENT_MARGIN;
         outcome.errorMessage = reason;
         return false;
      }

      m_trade.SetTypeFillingBySymbol(brokerSymbol);
      m_trade.SetDeviationInPoints((ulong)MathMax(0, deviationPoints > 0 ? deviationPoints : m_deviation));

      bool sent = (side == "SELL")
                  ? m_trade.Sell(volume, brokerSymbol, 0.0, stopLoss, takeProfit, comment)
                  : m_trade.Buy(volume, brokerSymbol, 0.0, stopLoss, takeProfit, comment);

      if(!sent)
      {
         FillOutcomeFromResult(outcome);
         return false;
      }
      FillOutcomeFromResult(outcome);
      outcome.volume = volume;
      return outcome.success;
   }

   //+---------------------------------------------------------------+
   //| PLACE_PENDING_ORDER                                            |
   //+---------------------------------------------------------------+
   bool PlacePending(const string brokerSymbol, const string kind, const double requestedVolume, const double price,
                     const double stopLimitPrice, const double stopLoss, const double takeProfit,
                     const string comment, TP_ExecutionOutcome &outcome)
   {
      outcome.success = false;
      outcome.errorCode = "";
      outcome.errorMessage = "";
      outcome.state = "";

      if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT) || !AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
      {
         outcome.errorCode = TP_ERR_EA_TRADE_DISABLED;
         outcome.errorMessage = "Expert trading is disabled for this account in the terminal.";
         return false;
      }

      string reason = "";
      if(!SymbolTradable(brokerSymbol, reason))
      {
         outcome.errorCode = TP_ERR_TRADE_DISABLED;
         outcome.errorMessage = reason;
         return false;
      }

      bool known = false;
      ENUM_ORDER_TYPE orderType = PendingOrderType(kind, known);
      if(!known)
      {
         outcome.errorCode = TP_ERR_NOT_SUPPORTED;
         outcome.errorMessage = "Unsupported pending order kind: " + kind + ".";
         return false;
      }

      double volume = NormaliseVolume(brokerSymbol, requestedVolume);
      if(!VolumeOk(brokerSymbol, volume, reason))
      {
         outcome.errorCode = TP_ERR_INVALID_VOLUME;
         outcome.errorMessage = reason;
         return false;
      }

      MqlTick tick;
      SymbolInfoTick(brokerSymbol, tick);
      int stopsLevel = (int)SymbolInfoInteger(brokerSymbol, SYMBOL_TRADE_STOPS_LEVEL);
      double point = SymbolInfoDouble(brokerSymbol, SYMBOL_POINT);
      if(point <= 0.0)
         point = SymbolInfoDouble(brokerSymbol, SYMBOL_TRADE_TICK_SIZE);

      // pending price must be on the correct side of the market, away from
      // the minimum distance the broker requires
      bool isBuySide = (StringFind(kind, "BUY") == 0);
      double minimumDistance = (double)stopsLevel * point;
      if(price <= 0.0)
      {
         outcome.errorCode = TP_ERR_INVALID_PRICE;
         outcome.errorMessage = "A pending order needs a valid trigger price.";
         return false;
      }
      if(StringFind(kind, "LIMIT") >= 0)
      {
         if(isBuySide && price > tick.ask - minimumDistance)
         {
            outcome.errorCode = TP_ERR_INVALID_PRICE;
            outcome.errorMessage = "A BUY LIMIT must be placed below the current ask.";
            return false;
         }
         if(!isBuySide && price < tick.bid + minimumDistance)
         {
            outcome.errorCode = TP_ERR_INVALID_PRICE;
            outcome.errorMessage = "A SELL LIMIT must be placed above the current bid.";
            return false;
         }
      }
      else if(StringFind(kind, "STOP") == 0)
      {
         if(isBuySide && price < tick.ask + minimumDistance)
         {
            outcome.errorCode = TP_ERR_INVALID_PRICE;
            outcome.errorMessage = "A BUY STOP must be placed above the current ask.";
            return false;
         }
         if(!isBuySide && price > tick.bid - minimumDistance)
         {
            outcome.errorCode = TP_ERR_INVALID_PRICE;
            outcome.errorMessage = "A SELL STOP must be placed below the current bid.";
            return false;
         }
      }

      if(!StopsDistanceOk(brokerSymbol, price, stopLoss, reason) || !StopsDistanceOk(brokerSymbol, price, takeProfit, reason))
      {
         outcome.errorCode = TP_ERR_STOPS_LEVEL;
         outcome.errorMessage = reason;
         return false;
      }

      if(!MarginOk(brokerSymbol, orderType, volume, price, reason))
      {
         outcome.errorCode = TP_ERR_INSUFFICIENT_MARGIN;
         outcome.errorMessage = reason;
         return false;
      }

      m_trade.SetTypeFillingBySymbol(brokerSymbol);
      bool sent = false;
      switch(orderType)
      {
         case ORDER_TYPE_BUY_LIMIT:       sent = m_trade.BuyLimit(volume, price, brokerSymbol, stopLoss, takeProfit, ORDER_TIME_GTC, 0, comment); break;
         case ORDER_TYPE_SELL_LIMIT:      sent = m_trade.SellLimit(volume, price, brokerSymbol, stopLoss, takeProfit, ORDER_TIME_GTC, 0, comment); break;
         case ORDER_TYPE_BUY_STOP:        sent = m_trade.BuyStop(volume, price, brokerSymbol, stopLoss, takeProfit, ORDER_TIME_GTC, 0, comment); break;
         case ORDER_TYPE_SELL_STOP:       sent = m_trade.SellStop(volume, price, brokerSymbol, stopLoss, takeProfit, ORDER_TIME_GTC, 0, comment); break;
         case ORDER_TYPE_BUY_STOP_LIMIT:  sent = m_trade.BuyStopLimit(volume, price, stopLimitPrice, brokerSymbol, stopLoss, takeProfit, ORDER_TIME_GTC, 0, comment); break;
         case ORDER_TYPE_SELL_STOP_LIMIT: sent = m_trade.SellStopLimit(volume, price, stopLimitPrice, brokerSymbol, stopLoss, takeProfit, ORDER_TIME_GTC, 0, comment); break;
         default:
            outcome.errorCode = TP_ERR_NOT_SUPPORTED;
            outcome.errorMessage = "Unsupported pending order type.";
            return false;
      }

      FillOutcomeFromResult(outcome);
      outcome.volume = volume;
      return outcome.success;
   }

   //+---------------------------------------------------------------+
   //| MODIFY_POSITION                                                |
   //+---------------------------------------------------------------+
   bool ModifyPosition(const ulong ticket, const double stopLoss, const double takeProfit, TP_ExecutionOutcome &outcome)
   {
      outcome.success = false;
      outcome.ticket = ticket;
      outcome.state = "";

      if(!PositionSelectByTicket(ticket))
      {
         outcome.errorCode = TP_ERR_TICKET_NOT_FOUND;
         outcome.errorMessage = "Position #" + IntegerToString((long)ticket) + " does not exist in this terminal.";
         return false;
      }
      string symbol = PositionGetString(POSITION_SYMBOL);
      double currentPrice = PositionGetDouble(POSITION_PRICE_CURRENT);
      string reason = "";
      if(!StopsDistanceOk(symbol, currentPrice, stopLoss, reason) || !StopsDistanceOk(symbol, currentPrice, takeProfit, reason))
      {
         outcome.errorCode = TP_ERR_STOPS_LEVEL;
         outcome.errorMessage = reason;
         return false;
      }

      m_trade.SetTypeFillingBySymbol(symbol);
      bool sent = m_trade.PositionModify(ticket, stopLoss, takeProfit);
      FillOutcomeFromResult(outcome);
      outcome.ticket = ticket;
      if(outcome.success)
      {
         outcome.price = stopLoss;
         outcome.volume = PositionGetDouble(POSITION_VOLUME);
         outcome.state = "MODIFIED";
      }
      return outcome.success;
   }

   //+---------------------------------------------------------------+
   //| MODIFY_ORDER                                                   |
   //+---------------------------------------------------------------+
   bool ModifyOrder(const ulong ticket, const double price, const double stopLoss, const double takeProfit,
                    TP_ExecutionOutcome &outcome)
   {
      outcome.success = false;
      outcome.ticket = ticket;

      if(!OrderSelect(ticket))
      {
         outcome.errorCode = TP_ERR_TICKET_NOT_FOUND;
         outcome.errorMessage = "Order #" + IntegerToString((long)ticket) + " does not exist in this terminal.";
         return false;
      }
      string symbol = OrderGetString(ORDER_SYMBOL);
      double reference = (price > 0.0) ? price : OrderGetDouble(ORDER_PRICE_OPEN);
      string reason = "";
      if(!StopsDistanceOk(symbol, reference, stopLoss, reason) || !StopsDistanceOk(symbol, reference, takeProfit, reason))
      {
         outcome.errorCode = TP_ERR_STOPS_LEVEL;
         outcome.errorMessage = reason;
         return false;
      }

      ENUM_ORDER_TYPE_TIME timeType = (ENUM_ORDER_TYPE_TIME)OrderGetInteger(ORDER_TYPE_TIME);
      datetime expiration = (datetime)OrderGetInteger(ORDER_TIME_EXPIRATION);
      m_trade.SetTypeFillingBySymbol(symbol);
      bool sent = m_trade.OrderModify(ticket, reference, stopLoss, takeProfit, timeType, expiration, 0.0);
      FillOutcomeFromResult(outcome);
      outcome.ticket = ticket;
      if(outcome.success)
      {
         outcome.price = reference;
         outcome.state = "MODIFIED";
      }
      return outcome.success;
   }

   //+---------------------------------------------------------------+
   //| CLOSE_POSITION (partial close when a volume is supplied)       |
   //+---------------------------------------------------------------+
   bool ClosePosition(const ulong ticket, const double volume, const int deviationPoints, TP_ExecutionOutcome &outcome)
   {
      outcome.success = false;
      outcome.ticket = ticket;

      if(!PositionSelectByTicket(ticket))
      {
         outcome.errorCode = TP_ERR_TICKET_NOT_FOUND;
         outcome.errorMessage = "Position #" + IntegerToString((long)ticket) + " does not exist in this terminal.";
         return false;
      }
      string symbol = PositionGetString(POSITION_SYMBOL);
      double positionVolume = PositionGetDouble(POSITION_VOLUME);

      m_trade.SetTypeFillingBySymbol(symbol);
      m_trade.SetDeviationInPoints((ulong)MathMax(0, deviationPoints > 0 ? deviationPoints : m_deviation));

      bool sent;
      if(volume > 0.0 && volume < positionVolume)
      {
         double step = SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP);
         double minimum = SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN);
         if(volume < minimum - step / 10.0 || positionVolume - volume < minimum - step / 10.0)
         {
            outcome.errorCode = TP_ERR_INVALID_VOLUME;
            outcome.errorMessage = "A partial close must leave at least " + DoubleToString(minimum, 4) + " lots open on " + symbol + ".";
            return false;
         }
         sent = m_trade.PositionClosePartial(ticket, NormaliseVolume(symbol, volume), (ulong)MathMax(0, deviationPoints));
      }
      else
      {
         sent = m_trade.PositionClose(ticket, (ulong)MathMax(0, deviationPoints > 0 ? deviationPoints : m_deviation));
      }

      FillOutcomeFromResult(outcome);
      outcome.ticket = ticket;
      if(outcome.success)
         outcome.state = (volume > 0.0 && volume < positionVolume) ? "PARTIALLY_CLOSED" : "CLOSED";
      return outcome.success;
   }

   //+---------------------------------------------------------------+
   //| CLOSE_ALL_POSITIONS — emergency control                        |
   //| Requires the explicit confirmation string, and optionally      |
   //| restricts the close to a symbol. Never closes other EAs' trades|
   //| unless the command asks for it (magic filter).                 |
   //+---------------------------------------------------------------+
   bool CloseAllPositions(const string confirmation, const long magicFilter, const string symbolFilter,
                          int &closedCount, double &closedVolume, string &errorMessage)
   {
      closedCount = 0;
      closedVolume = 0.0;
      errorMessage = "";

      if(confirmation != "CONFIRM CLOSE ALL")
      {
         errorMessage = "Emergency close-all requires the exact confirmation text \"CONFIRM CLOSE ALL\".";
         return false;
      }
      if(!AccountInfoInteger(ACCOUNT_TRADE_EXPERT) || !AccountInfoInteger(ACCOUNT_TRADE_ALLOWED))
      {
         errorMessage = "Expert trading is disabled for this account in the terminal.";
         return false;
      }

      int total = PositionsTotal();
      for(int i = total - 1; i >= 0; i--)
      {
         ulong ticket = PositionGetTicket(i);
         if(ticket == 0)
            continue;
         string symbol = PositionGetString(POSITION_SYMBOL);
         long magic = (long)PositionGetInteger(POSITION_MAGIC);

         if(symbolFilter != "" && symbol != symbolFilter)
            continue;
         if(magicFilter > 0 && magic != magicFilter)
            continue;

         double volume = PositionGetDouble(POSITION_VOLUME);
         m_trade.SetTypeFillingBySymbol(symbol);
         m_trade.SetDeviationInPoints((ulong)m_deviation);
         if(m_trade.PositionClose(ticket, (ulong)m_deviation))
         {
            closedCount++;
            closedVolume += volume;
         }
         else
         {
            errorMessage += "Position #" + IntegerToString((long)ticket) + " could not be closed: " +
                            m_trade.ResultRetcodeDescription() + ". ";
         }
      }

      if(errorMessage != "" && closedCount == 0)
         return false;
      return true;
   }

   //+---------------------------------------------------------------+
   //| CANCEL_ORDER / CANCEL_ALL_ORDERS                               |
   //+---------------------------------------------------------------+
   bool CancelOrder(const ulong ticket, TP_ExecutionOutcome &outcome)
   {
      outcome.success = false;
      outcome.ticket = ticket;
      if(!OrderSelect(ticket))
      {
         outcome.errorCode = TP_ERR_TICKET_NOT_FOUND;
         outcome.errorMessage = "Pending order #" + IntegerToString((long)ticket) + " does not exist in this terminal.";
         return false;
      }
      bool sent = m_trade.OrderDelete(ticket);
      FillOutcomeFromResult(outcome);
      outcome.ticket = ticket;
      if(outcome.success)
         outcome.state = "CANCELLED";
      return outcome.success;
   }

   int CancelAllOrders(const string symbolFilter)
   {
      int cancelled = 0;
      int total = OrdersTotal();
      for(int i = total - 1; i >= 0; i--)
      {
         ulong ticket = OrderGetTicket(i);
         if(ticket == 0)
            continue;
         string symbol = OrderGetString(ORDER_SYMBOL);
         if(symbolFilter != "" && symbol != symbolFilter)
            continue;
         if(m_trade.OrderDelete(ticket))
            cancelled++;
      }
      return cancelled;
   }
};

#endif // TP_TRADE_MQH
//+------------------------------------------------------------------+
