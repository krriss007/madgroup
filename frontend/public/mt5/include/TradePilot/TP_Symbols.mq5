//+------------------------------------------------------------------+
//|                                            TP_Symbols.mq5        |
//|  TradePilot — symbol discovery, broker-name resolution and       |
//|  specification serialisation.                                    |
//|                                                                  |
//|  Brokers rename instruments constantly: XAUUSD, XAUUSDm, XAUUSD., |
//|  XAUUSDpro, GOLD, GOLD.spot …  The web app therefore never hard-  |
//|  codes contract data. Instead the EA reports every symbol it can  |
//|  see, together with its real specification, and resolves a         |
//|  canonical request ("XAUUSD") to the broker's actual name.        |
//+------------------------------------------------------------------+
#property copyright "TradePilot"
#property version   "1.00"

#ifndef TP_SYMBOLS_MQH
#define TP_SYMBOLS_MQH

#include "TP_Json.mq5"

#define TP_MAX_REPORTED_SYMBOLS 220

//--- decoration lists mirrored from shared/src/lib/symbols.ts ----------
string TP_KnownSuffixes[] =
{
   "m", "micro", ".", ".a", ".b", ".c", ".pro", ".raw", ".ecn", "pro", "raw", "ecn", "i", "s", "z", "_", "-i", ".i"
};
string TP_KnownPrefixes[] = { "#", "=", "FX.", "FOREX." };

//--- the instruments TradePilot ships by default ------------------------
string TP_DefaultWatchlist[] =
{
   "XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "AUDUSD", "USDCAD", "NZDUSD", "EURGBP", "EURJPY", "GBPJPY"
};

//+------------------------------------------------------------------+
//| Remove broker decoration and punctuation.                         |
//+------------------------------------------------------------------+
string TP_StripDecoration(const string rawName)
{
   string name = rawName;
   StringToUpper(name);
   StringTrimLeft(name);
   StringTrimRight(name);

   int prefixCount = ArraySize(TP_KnownPrefixes);
   for(int i = 0; i < prefixCount; i++)
   {
      string prefix = TP_KnownPrefixes[i];
      StringToUpper(prefix);
      int prefixLen = StringLen(prefix);
      if(prefixLen > 0 && StringLen(name) > prefixLen && StringSubstr(name, 0, prefixLen) == prefix)
         name = StringSubstr(name, prefixLen);
   }

   bool changed = true;
   int guard = 0;
   while(changed && guard < 12)
   {
      changed = false;
      guard++;
      int suffixCount = ArraySize(TP_KnownSuffixes);
      for(int i = 0; i < suffixCount; i++)
      {
         string suffix = TP_KnownSuffixes[i];
         StringToUpper(suffix);
         int suffixLen = StringLen(suffix);
         int nameLen = StringLen(name);
         if(suffixLen > 0 && nameLen > suffixLen && StringSubstr(name, nameLen - suffixLen, suffixLen) == suffix)
         {
            name = StringSubstr(name, 0, nameLen - suffixLen);
            changed = true;
            break;
         }
      }
   }

   // keep letters and digits only
   string cleaned = "";
   int length = StringLen(name);
   for(int i = 0; i < length; i++)
   {
      ushort c = StringGetCharacter(name, i);
      if((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9'))
         cleaned += ShortToString(c);
   }
   return cleaned;
}

//+------------------------------------------------------------------+
//| Canonical instrument for a broker symbol (same rules as the web).|
//+------------------------------------------------------------------+
bool TP_IsDefaultInstrument(const string canonical)
{
   int count = ArraySize(TP_DefaultWatchlist);
   for(int i = 0; i < count; i++)
      if(TP_DefaultWatchlist[i] == canonical)
         return true;
   return false;
}

string TP_Canonicalize(const string brokerSymbol)
{
   string upper = brokerSymbol;
   StringToUpper(upper);
   StringTrimLeft(upper);
   StringTrimRight(upper);

   if(TP_IsDefaultInstrument(upper))
      return upper;

   string stripped = TP_StripDecoration(upper);
   if(TP_IsDefaultInstrument(stripped))
      return stripped;

   // substring hit: XAUUSDm -> XAUUSD, GBPJPY.raw -> GBPJPY
   int count = ArraySize(TP_DefaultWatchlist);
   for(int i = 0; i < count; i++)
   {
      if(StringFind(upper, TP_DefaultWatchlist[i]) >= 0)
         return TP_DefaultWatchlist[i];
   }

   if(StringSubstr(stripped, 0, 3) == "XAU" || StringSubstr(stripped, 0, 4) == "GOLD")
      return "XAUUSD";
   if(StringSubstr(stripped, 0, 3) == "XAG" || StringSubstr(stripped, 0, 6) == "SILVER")
      return "XAGUSD";

   return (stripped == "") ? upper : stripped;
}

//+------------------------------------------------------------------+
//| Resolve a canonical request to the broker's actual symbol name.   |
//| Order: exact → decoration-stripped → substring → description hit.  |
//+------------------------------------------------------------------+
bool TP_ResolveSymbol(const string requested, string &brokerSymbol)
{
   string upper = requested;
   StringToUpper(upper);
   StringTrimLeft(upper);
   StringTrimRight(upper);

   if(SymbolSelect(upper, true) && SymbolInfoInteger(upper, SYMBOL_SELECT))
   {
      brokerSymbol = upper;
      return true;
   }

   string wanted = TP_Canonicalize(upper);
   int total = SymbolsTotal(false);   // symbols available from the broker
   if(total <= 0)
      total = SymbolsTotal(true);      // fall back to the Market Watch

   string best = "";
   string bestDescription = "";

   for(int i = 0; i < total; i++)
   {
      string name = SymbolName(i, false);
      if(name == "")
         name = SymbolName(i, true);
      if(name == "")
         continue;

      string canonical = TP_Canonicalize(name);
      if(canonical != wanted)
         continue;

      string description = SymbolInfoString(name, SYMBOL_DESCRIPTION);
      string descriptionUpper = description;
      StringToUpper(descriptionUpper);

      bool isGold = (wanted == "XAUUSD" && (StringFind(descriptionUpper, "GOLD") >= 0 || StringFind(descriptionUpper, "XAU") >= 0));
      if(isGold || description != "")
      {
         // Prefer a symbol that is already visible in Market Watch.
         if(best == "" || SymbolInfoInteger(name, SYMBOL_SELECT) || SymbolInfoInteger(name, SYMBOL_VISIBLE))
         {
            best = name;
            bestDescription = description;
            if(SymbolInfoInteger(name, SYMBOL_SELECT) || SymbolInfoInteger(name, SYMBOL_VISIBLE))
               break;
         }
      }
   }

   if(best != "")
   {
      SymbolSelect(best, true);
      brokerSymbol = best;
      return true;
   }

   brokerSymbol = "";
   return false;
}

//+------------------------------------------------------------------+
//| Serialise one symbol specification for the web layer.             |
//+------------------------------------------------------------------+
string TP_SymbolPayload(const string symbol)
{
   string json = "{";
   json += "\"symbol\":" + TP_Json::Escape(symbol);
   json += ",\"description\":" + TP_Json::Escape(SymbolInfoString(symbol, SYMBOL_DESCRIPTION));
   json += ",\"path\":" + TP_Json::Escape(SymbolInfoString(symbol, SYMBOL_PATH));
   json += ",\"currency_base\":" + TP_Json::Escape(SymbolInfoString(symbol, SYMBOL_CURRENCY_BASE));
   json += ",\"currency_profit\":" + TP_Json::Escape(SymbolInfoString(symbol, SYMBOL_CURRENCY_PROFIT));
   json += ",\"currency_margin\":" + TP_Json::Escape(SymbolInfoString(symbol, SYMBOL_CURRENCY_MARGIN));
   json += ",\"digits\":" + IntegerToString((int)SymbolInfoInteger(symbol, SYMBOL_DIGITS));
   json += ",\"point\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_POINT), 10));
   json += ",\"tick_size\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_SIZE), 10));
   json += ",\"tick_value\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE), 8));
   json += ",\"tick_value_profit\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE_PROFIT), 8));
   json += ",\"tick_value_loss\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_TRADE_TICK_VALUE_LOSS), 8));
   json += ",\"contract_size\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_TRADE_CONTRACT_SIZE), 8));
   json += ",\"volume_min\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_VOLUME_MIN), 8));
   json += ",\"volume_max\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_VOLUME_MAX), 8));
   json += ",\"volume_step\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_VOLUME_STEP), 8));
   json += ",\"stops_level\":" + IntegerToString((int)SymbolInfoInteger(symbol, SYMBOL_TRADE_STOPS_LEVEL));
   json += ",\"freeze_level\":" + IntegerToString((int)SymbolInfoInteger(symbol, SYMBOL_TRADE_FREEZE_LEVEL));
   json += ",\"trade_mode\":" + IntegerToString((int)SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE));
   json += ",\"trade_allowed\":" + ((SymbolInfoInteger(symbol, SYMBOL_TRADE_MODE) == SYMBOL_TRADE_MODE_DISABLED) ? "false" : "true");
   json += ",\"swap_long\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_SWAP_LONG), 8));
   json += ",\"swap_short\":" + TP_Json::FormatNumber(DoubleToString(SymbolInfoDouble(symbol, SYMBOL_SWAP_SHORT), 8));
   json += ",\"sessions\":[]";
   json += "}";
   return json;
}

//+------------------------------------------------------------------+
//| Which symbols should be reported to the backend?                  |
//| Market Watch first (what the user actually watches), then any     |
//| symbol whose canonical name is in the TradePilot default set.      |
//+------------------------------------------------------------------+
int TP_CollectReportableSymbols(string &symbols[])
{
   int count = 0;
   ArrayResize(symbols, 0);

   int watchCount = SymbolsTotal(true);
   for(int i = 0; i < watchCount && count < TP_MAX_REPORTED_SYMBOLS; i++)
   {
      string name = SymbolName(i, true);
      if(name == "")
         continue;
      ArrayResize(symbols, count + 1);
      symbols[count] = name;
      count++;
   }

   int allCount = SymbolsTotal(false);
   for(int i = 0; i < allCount && count < TP_MAX_REPORTED_SYMBOLS; i++)
   {
      string name = SymbolName(i, false);
      if(name == "")
         continue;
      string canonical = TP_Canonicalize(name);
      if(!TP_IsDefaultInstrument(canonical))
         continue;
      bool duplicate = false;
      for(int j = 0; j < count; j++)
      {
         if(symbols[j] == name)
         {
            duplicate = true;
            break;
         }
      }
      if(duplicate)
         continue;
      ArrayResize(symbols, count + 1);
      symbols[count] = name;
      count++;
   }

   return count;
}

#endif // TP_SYMBOLS_MQH
//+------------------------------------------------------------------+
