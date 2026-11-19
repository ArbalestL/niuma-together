using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace NiuMa
{
    internal sealed class RoomSession
    {
        public string code { get; set; }
        public string id { get; set; }
        public string token { get; set; }
        public bool host { get; set; }
    }

    internal sealed class RoomMember
    {
        public string id { get; set; }
        public string name { get; set; }
        public bool online { get; set; }
        public bool background { get; set; }
        public double? backgroundSeconds { get; set; }
        public double? offlineSeconds { get; set; }
        public MemberSnapshot snapshot { get; set; }
        public string ManagementLabel
        {
            get { return name + (online ? "（在线）" : "（离线）") + " · " + id.Substring(id.Length - 4); }
        }
    }

    internal sealed class MemberSnapshot
    {
        public string state { get; set; }
        public double progress { get; set; }
        public double offIn { get; set; }
        public RoomMoney money { get; set; }
        public string wish { get; set; }
    }

    internal sealed class RoomMoney
    {
        public double earned { get; set; }
        public string currency { get; set; }
    }

    internal sealed class RoomView
    {
        public RoomMember[] members { get; set; }
        public bool host { get; set; }
    }

    internal sealed class RoomError : Exception
    {
        public RoomError(string code) : base(code) { }
    }

    internal static class RoomApi
    {
        static readonly HttpClient Client = new HttpClient(new HttpClientHandler { AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(5),
            MaxResponseContentBufferSize = 128 * 1024
        };

        public static async Task<T> Send<T>(Uri server, string action, object data, string token)
        {
            var json = new JavaScriptSerializer();
            using (var request = new HttpRequestMessage(HttpMethod.Post, new Uri(server, "/api/v1/" + action)))
            {
                request.Content = new StringContent(json.Serialize(data), Encoding.UTF8, "application/json");
                if (token != null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
                using (var response = await Client.SendAsync(request).ConfigureAwait(false))
                {
                    var body = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
                    if (!response.IsSuccessStatusCode)
                    {
                        var error = json.Deserialize<ErrorResponse>(body);
                        throw new RoomError(error == null ? "SERVER_ERROR" : error.error);
                    }
                    return json.Deserialize<T>(body);
                }
            }
        }

        sealed class ErrorResponse
        {
            public string error { get; set; }
        }
    }
}
