//+------------------------------------------------------------------+
//|                                             CandlebenchFeed.mq4  |
//|  Candlebench - MT4 -> website live market-data feeder            |
//|                                                                  |
//|  WHAT THIS EA DOES                                               |
//|    Sends recent OHLCV bars of the chart it is attached to, via   |
//|    HTTP POST, to a Candlebench server's ingest endpoint. The     |
//|    website then charts/analyses/paper-trades that market using   |
//|    your broker's live prices.                                    |
//|                                                                  |
//|  WHAT IT DOES NOT DO                                             |
//|    - It is strictly READ-ONLY market data. It places no orders,  |
//|    - Candlebench never sends anything back for execution, and    |
//|    - no account number, balance or credentials are transmitted.  |
//|    Candlebench itself is a paper-trading app: no real-money      |
//|    orders exist anywhere in that system.                         |
//|                                                                  |
//|  SETUP (one time)                                                |
//|    1. Copy this file to:  <MT4 Data Folder>\MQL4\Experts\        |
//|    2. Open MetaEditor (F4), open the file, press Compile.        |
//|    3. In MT4: Tools -> Options -> Expert Advisors ->             |
//|       tick "Allow WebRequest for listed URL" and add the host    |
//|       of your ingest URL (the EA prints it in the Experts log).  |
//|    4. Drag the EA onto ANY chart of the symbol you want to feed, |
//|       ideally a timeframe of M1, M5, M15, H1, H4 or D1.          |
//|                                                                  |
//|  NOTES                                                           |
//|    - The target market on the website must be one of the app's   |
//|      supported symbols (GET /api/meta). Common broker symbols    |
//|      are auto-mapped: EURUSD -> EUR-USD, USDJPY -> USD-JPY,      |
//|      XAUUSD -> XAU-USD, BTCUSD -> BTC-USD, etc. Otherwise set    |
//|      "App symbol override" manually.                             |
//|    - MT4 brokers timestamp bars in the BROKER's server time.     |
//|      The server transparently re-anchors bar times to real UTC   |
//|      ("align":"lastBar"); the applied shift is logged and shown. |
//|    - The feed is used by the website only while this EA keeps    |
//|      posting. Stop the EA and the site falls back gracefully.    |
//+------------------------------------------------------------------+
#property strict
#property copyright "Candlebench educational demo - paper trading only, not financial advice"
#property version   "1.00"
#property description "Read-only market-data feeder: pushes chart candles to a Candlebench server."

//--- inputs
input string InpIngestUrl  = "http://localhost:3000/api/market/ingest"; // Ingest URL (POST)
input int    InpPeriodSec  = 5;      // Update interval (seconds, min 2)
input int    InpBars       = 300;    // Bars per update (10..1000)
input string InpAppSymbol  = "";     // App symbol override (e.g. EUR-USD). Auto-map if empty.
input string InpProvider   = "MT4";  // Provider label shown on the website
input bool   InpUseChartTF = true;   // true = chart timeframe, false = InpTimeframe below
input int    InpTimeframe  = PERIOD_M1; // Timeframe when InpUseChartTF = false

datetime g_lastSend = 0;
string   g_appSymbol = "";
string   g_tf        = "";
int      g_tfSeconds = 0;

//+------------------------------------------------------------------+
int OnInit()
{
   if (InpPeriodSec < 2)  { Alert("Candlebench: update interval must be >= 2 seconds.");  return INIT_PARAMETERS_INCORRECT; }
   if (StringLen(InpProvider) == 0 || StringLen(InpProvider) > 40) { Alert("Candlebench: provider label must be 1..40 characters."); return INIT_PARAMETERS_INCORRECT; }

   g_tfSeconds = InpUseChartTF ? Period() : InpTimeframe;
   g_tf = TfToApp(g_tfSeconds);
   if (g_tf == "") {
      Alert("Candlebench: unsupported chart timeframe. Attach to an M1, M5, M15, H1, H4 or D1 chart ",
            "(or set 'Use chart timeframe' = false with a supported InpTimeframe).");
      return INIT_PARAMETERS_INCORRECT;
   }

   g_appSymbol = MapSymbol();
   if (StringLen(InpAppSymbol) == 0) {
      Print("Candlebench: auto-mapped broker symbol '", Symbol(), "' -> app market '", g_appSymbol,
            "'. If the website rejects it, set 'App symbol override' to a supported market.");
   }

   EventSetTimer(1);
   Print("Candlebench feed started: ", Symbol(), " -> ", g_appSymbol, " @ ", g_tf,
         " every ", InpPeriodSec, "s, ", MathMax(10, MathMin(InpBars, 1000)), " bars");
   Print("Candlebench REQUIREMENT: Tools -> Options -> Expert Advisors -> 'Allow WebRequest for listed URL' must include: ",
         HostOf(InpIngestUrl));
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   EventKillTimer();
   Print("Candlebench feed stopped. The website will stop using this feed once it goes stale.");
}

//+------------------------------------------------------------------+
void OnTimer()
{
   if (TimeCurrent() - g_lastSend < InpPeriodSec) return;
   g_lastSend = TimeCurrent();
   SendSnapshot();
}

//+------------------------------------------------------------------+
//| Map the broker symbol to a Candlebench market symbol.            |
//+------------------------------------------------------------------+
string MapSymbol()
{
   if (StringLen(InpAppSymbol) > 0) return InpAppSymbol;

   string s = Symbol();
   StringToUpper(s);

   // Keep A-Z only: strips broker suffixes like "EURUSD.a", "EURUSDm", "EURUSD-pro"
   string clean = "";
   for (int i = 0; i < StringLen(s); i++) {
      string ch = StringSubstr(s, i, 1);
      if (ch >= "A" && ch <= "Z") clean = clean + ch;
   }

   if (StringLen(clean) == 6) {
      string base  = StringSubstr(clean, 0, 3);
      string quote = StringSubstr(clean, 3, 3);
      if (base == "XAU" || base == "XAG")            return base + "-USD";
      if (base == "BTC" || base == "ETH")            return base + "-USD";
      if (quote == "USD" || quote == "JPY" ||
          quote == "CAD" || base == "EUR" ||
          base == "GBP" || base == "AUD")            return base + "-" + quote;
   }
   // Unknown shapes are sent as-is; the server replies with the supported list.
   return clean;
}

//+------------------------------------------------------------------+
//| MQL4 timeframe -> Candlebench timeframe id.                      |
//+------------------------------------------------------------------+
string TfToApp(int tf)
{
   switch (tf) {
      case PERIOD_M1:  return "1m";
      case PERIOD_M5:  return "5m";
      case PERIOD_M15: return "15m";
      case PERIOD_H1:  return "1h";
      case PERIOD_H4:  return "4h";
      case PERIOD_D1:  return "1d";
   }
   return "";
}

//+------------------------------------------------------------------+
//| "https://host:port/api/..." -> "host:port"                       |
//+------------------------------------------------------------------+
string HostOf(string url)
{
   int p = StringFind(url, "//");
   if (p < 0) return url;
   string rest = StringSubstr(url, p + 2);
   int q = StringFind(rest, "/");
   if (q < 0) return rest;
   return StringSubstr(rest, 0, q);
}

//+------------------------------------------------------------------+
//| Collect bars and POST them to the ingest endpoint.               |
//+------------------------------------------------------------------+
void SendSnapshot()
{
   int want = MathMax(10, MathMin(InpBars, 1000));

   MqlRates rates[];
   ArraySetAsSeries(rates, false); // rates[0] = oldest
   ResetLastError();
   int copied = CopyRates(Symbol(), g_tfSeconds, 0, want, rates);
   if (copied < 10) {
      Print("Candlebench: not enough history yet (CopyRates returned ", copied, ", error ", GetLastError(), ")");
      return;
   }

   //--- build JSON: {"symbol":..,"tf":..,"provider":..,"align":"lastBar","candles":[[t,o,h,l,c,v],...]}
   string json = "{\"symbol\":\"" + g_appSymbol + "\",\"tf\":\"" + g_tf +
                 "\",\"provider\":\"" + InpProvider + "\",\"align\":\"lastBar\",\"candles\":[";
   for (int i = 0; i < copied; i++) {
      if (i > 0) json = json + ",";
      json = json + "[" +
             IntegerToString((long)rates[i].time * 1000) + "," +
             DoubleToString(rates[i].open, 8) + "," +
             DoubleToString(rates[i].high, 8) + "," +
             DoubleToString(rates[i].low, 8) + "," +
             DoubleToString(rates[i].close, 8) + "," +
             IntegerToString((long)rates[i].tick_volume) + "]";
   }
   json = json + "]}";

   //--- POST via WebRequest
   char postData[];
   char resultData[];
   string resultHeaders = "";
   StringToCharArray(json, postData, 0, StringLen(json));

   ResetLastError();
   int status = WebRequest("POST", InpIngestUrl, "Content-Type: application/json\r\n", 5000,
                           postData, resultData, resultHeaders);
   if (status == -1) {
      Print("Candlebench: WebRequest failed (error ", GetLastError(), "). ",
            "Add this URL's host under Tools -> Options -> Expert Advisors -> Allow WebRequest: ",
            HostOf(InpIngestUrl));
      return;
   }
   if (status != 200) {
      string resp = "";
      int size = ArraySize(resultData);
      for (int k = 0; k < MathMin(size, 300); k++) resp = resp + CharToString((uchar)resultData[k]);
      Print("Candlebench: server replied HTTP ", status, ": ", resp);
      return;
   }
   Print("Candlebench: sent ", copied, " bars of ", Symbol(), " @ ", g_tf, " (HTTP 200)");
}
//+------------------------------------------------------------------+
