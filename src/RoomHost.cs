using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

namespace NiuMa
{
    internal sealed class RoomHost : IDisposable
    {
        readonly object _gate = new object();
        readonly string _directory;
        Process _process;
        TaskCompletionSource<Uri> _local;
        TaskCompletionSource<Uri> _public;
        bool _disposed;

        internal RoomHost(string directory) { _directory = directory; }

        internal Task<Uri> LocalAddress()
        {
            lock (_gate)
            {
                if (_disposed) throw new ObjectDisposedException("RoomHost");
                if (_process == null) Start();
                return WaitFor(_local.Task, 10, "LOCAL_TIMEOUT");
            }
        }

        internal async Task<Uri> PublicAddress()
        {
            await LocalAddress().ConfigureAwait(false);
            Task<Uri> address;
            lock (_gate)
            {
                if (_process == null) throw new RoomError("HOST_STOPPED");
                if (_public == null || _public.Task.IsFaulted)
                {
                    _public = NewAddress();
                    try { _process.StandardInput.WriteLine("public"); }
                    catch (IOException) { _public.TrySetException(new RoomError("HOST_STOPPED")); }
                }
                address = _public.Task;
            }
            return await WaitFor(address, 85, "TUNNEL_TIMEOUT").ConfigureAwait(false);
        }

        static TaskCompletionSource<Uri> NewAddress()
        {
            return new TaskCompletionSource<Uri>(TaskCreationOptions.RunContinuationsAsynchronously);
        }

        static async Task<Uri> WaitFor(Task<Uri> task, int seconds, string error)
        {
            using (var timeout = new System.Threading.CancellationTokenSource())
            {
                if (await Task.WhenAny(task, Task.Delay(TimeSpan.FromSeconds(seconds), timeout.Token)).ConfigureAwait(false) != task)
                    throw new RoomError(error);
                timeout.Cancel();
                return await task.ConfigureAwait(false);
            }
        }

        void Start()
        {
            var runtime = Path.Combine(_directory, "runtime", "node.exe");
            if (!File.Exists(runtime) || !File.Exists(Path.Combine(_directory, "launch.mjs")))
                throw new RoomError("MISSING_RUNTIME");
            var child = new Process
            {
                StartInfo = new ProcessStartInfo(runtime, "launch.mjs --managed")
                {
                    WorkingDirectory = _directory,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardInput = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                },
                EnableRaisingEvents = true
            };
            _local = NewAddress();
            _public = null;
            child.OutputDataReceived += (sender, e) => OnOutput(child, e.Data);
            child.ErrorDataReceived += (sender, e) => { }; // Drain cloudflared output so it cannot block the service.
            child.Exited += (sender, e) => OnExit(child);
            _process = child;
            try
            {
                child.Start();
                child.BeginOutputReadLine();
                child.BeginErrorReadLine();
            }
            catch
            {
                _process = null;
                try { child.StandardInput.Close(); } catch (InvalidOperationException) { }
                child.Dispose();
                throw new RoomError("LOCAL_START_FAILED");
            }
        }

        void OnOutput(Process child, string line)
        {
            if (line == null) return;
            lock (_gate)
            {
                if (_process != child) return;
                Uri address;
                const string local = "LOCAL URL: ";
                const string external = "PUBLIC URL: ";
                const string error = "TUNNEL ERROR: ";
                if (line.StartsWith(local, StringComparison.Ordinal) &&
                    Uri.TryCreate(line.Substring(local.Length), UriKind.Absolute, out address) &&
                    address.IsLoopback && address.Scheme == Uri.UriSchemeHttp)
                    _local.TrySetResult(address);
                else if (_public != null && line.StartsWith(external, StringComparison.Ordinal) &&
                    Uri.TryCreate(line.Substring(external.Length), UriKind.Absolute, out address) &&
                    address.Scheme == Uri.UriSchemeHttps && address.Host.EndsWith(".trycloudflare.com", StringComparison.OrdinalIgnoreCase))
                    _public.TrySetResult(address);
                else if (_public != null && line.StartsWith(error, StringComparison.Ordinal))
                    _public.TrySetException(new RoomError("TUNNEL_" + line.Substring(error.Length)));
                else if (line == "TUNNEL DOWN")
                    _public = null;
            }
        }

        void OnExit(Process child)
        {
            lock (_gate)
            {
                if (_process != child) return;
                _process = null;
                _local.TrySetException(new RoomError("HOST_STOPPED"));
                if (_public != null) _public.TrySetException(new RoomError("HOST_STOPPED"));
                child.Dispose();
            }
        }

        public void Dispose()
        {
            Process child;
            lock (_gate)
            {
                _disposed = true;
                child = _process;
                _process = null;
                if (child == null) return;
                _local.TrySetException(new RoomError("HOST_STOPPED"));
                if (_public != null) _public.TrySetException(new RoomError("HOST_STOPPED"));
            }
            try
            {
                child.StandardInput.Close();
                if (!child.WaitForExit(2000)) child.Kill();
            }
            catch (IOException) { }
            catch (InvalidOperationException) { }
            finally { child.Dispose(); }
        }
    }
}
