//+------------------------------------------------------------------+
//|                                               TP_Http.mq5        |
//|  TradePilot — HTTP client for the bridge (WebRequest wrapper).   |
//|                                                                  |
//|  Only the terminal's own WebRequest is used: no DLLs, no sockets, |
//|  no file system access. The URL must be added to                  |
//|    Tools → Options → Expert Advisors → Allow WebRequest for       |
//|    listed URL                                                    |
//|  otherwise MT5 refuses the call (error 4060) — the EA reports the |
//|  exact reason in the Experts log and in the comment on the chart. |
//+------------------------------------------------------------------+
#property copyright "TradePilot"
#property version   "1.00"

#ifndef TP_HTTP_MQH
#define TP_HTTP_MQH

#define TP_HTTP_ERR_NOT_ALLOWED    4060
#define TP_HTTP_ERR_INVALID_URL    5200
#define TP_HTTP_ERR_FAILED         5203
#define TP_HTTP_ERR_TIMEOUT        5201
#define TP_HTTP_ERR_NOT_CONNECTED  5202

struct TP_HttpResponse
{
   bool   ok;        // transport level success (HTTP status 2xx)
   int    status;    // HTTP status code
   string body;
   string error;     // human readable transport error, empty when ok
   uint   durationMs;
};

class TP_Http
{
private:
   string m_baseUrl;      // e.g. "https://backend.example.com"
   string m_deviceHeader; // x-tradepilot-device
   string m_tokenHeader;  // x-tradepilot-token
   int    m_timeoutMs;
   int    m_consecutiveFailures;
   datetime m_backoffUntil;

   string BuildHeaders()
   {
      string headers = "Content-Type: application/json\r\n";
      headers += "Accept: application/json\r\n";
      headers += "x-tradepilot-device: " + m_deviceHeader + "\r\n";
      headers += "x-tradepilot-token: " + m_tokenHeader + "\r\n";
      headers += "x-tradepilot-protocol: 1.0.0\r\n";
      return headers;
   }

   bool Transport(const string method, const string url, const string body, TP_HttpResponse &response)
   {
      response.ok = false;
      response.status = 0;
      response.body = "";
      response.error = "";

      char data[];
      int dataSize = 0;
      if(body != "")
      {
         int copied = StringToCharArray(body, data, 0, StringLen(body), CP_UTF8);
         dataSize = (copied > 0) ? copied : 0;
      }
      else
      {
         ArrayResize(data, 0);
      }

      char result[];
      string resultHeaders = "";
      uint started = GetTickCount();
      ResetLastError();
      int status = WebRequest(method, url, BuildHeaders(), m_timeoutMs, data, dataSize, result, resultHeaders);
      response.durationMs = GetTickCount() - started;

      if(status == -1)
      {
         int error = GetLastError();
         response.status = 0;
         switch(error)
         {
            case TP_HTTP_ERR_NOT_ALLOWED:
               response.error = "WebRequest is not allowed for " + m_baseUrl +
                                " — add it to Tools > Options > Expert Advisors > Allow WebRequest for listed URL.";
               break;
            case TP_HTTP_ERR_INVALID_URL:
               response.error = "Invalid backend URL: " + url;
               break;
            case TP_HTTP_ERR_TIMEOUT:
               response.error = "The backend did not answer in time (" + IntegerToString(m_timeoutMs) + " ms).";
               break;
            case TP_HTTP_ERR_NOT_CONNECTED:
               response.error = "Could not connect to the backend — check the network and that the backend is running.";
               break;
            default:
               response.error = "WebRequest failed with error " + IntegerToString(error) + " (" +
                                (error == TP_HTTP_ERR_FAILED ? "request could not be sent" : "see MQL5 error codes") + ").";
               break;
         }
         return false;
      }

      response.status = status;
      response.body = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
      response.ok = (status >= 200 && status < 300);
      if(!response.ok)
         response.error = "HTTP " + IntegerToString(status) + " from " + url;
      return response.ok;
   }

public:
   TP_Http()
   {
      m_baseUrl = "";
      m_deviceHeader = "";
      m_tokenHeader = "";
      m_timeoutMs = 10000;
      m_consecutiveFailures = 0;
      m_backoffUntil = 0;
   }

   void Configure(const string baseUrl, const string deviceId, const string deviceToken, const int timeoutMs)
   {
      m_baseUrl = baseUrl;
      // Strip a trailing slash so path concatenation stays predictable.
      while(StringLen(m_baseUrl) > 0 && StringGetCharacter(m_baseUrl, StringLen(m_baseUrl) - 1) == '/')
         m_baseUrl = StringSubstr(m_baseUrl, 0, StringLen(m_baseUrl) - 1);
      m_deviceHeader = deviceId;
      m_tokenHeader = deviceToken;
      m_timeoutMs = timeoutMs;
   }

   string BaseUrl() { return m_baseUrl; }
   int    TimeoutMs() { return m_timeoutMs; }
   int    ConsecutiveFailures() { return m_consecutiveFailures; }

   bool IsBackingOff()
   {
      return (m_backoffUntil > 0 && TimeCurrent() < m_backoffUntil);
   }

   void NoteSuccess()
   {
      m_consecutiveFailures = 0;
      m_backoffUntil = 0;
   }

   //--- exponential backoff, capped at 60 s, so a dead backend never spins
   void NoteFailure()
   {
      m_consecutiveFailures++;
      int seconds = 1;
      for(int i = 1; i < m_consecutiveFailures && seconds < 60; i++)
         seconds *= 2;
      if(seconds > 60)
         seconds = 60;
      m_backoffUntil = TimeCurrent() + seconds;
   }

   bool Post(const string path, const string jsonBody, TP_HttpResponse &response)
   {
      return Transport("POST", m_baseUrl + path, jsonBody, response);
   }

   bool Get(const string path, TP_HttpResponse &response)
   {
      return Transport("GET", m_baseUrl + path, "", response);
   }
};

#endif // TP_HTTP_MQH
//+------------------------------------------------------------------+
