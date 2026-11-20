using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Threading;

namespace NiuMa
{
    internal sealed class RoomWindow : Window
    {
        const string MobileEntry = "https://arbalestl.github.io/niuma-together/";

        readonly MainWindow _main;
        readonly DispatcherTimer _timer;
        readonly TextBox _serverInput = new TextBox();
        readonly TextBox _name = new TextBox { MaxLength = 24 };
        readonly TextBox _invite = new TextBox { MaxLength = 2048 };
        readonly TextBlock _status = new TextBlock { TextWrapping = TextWrapping.Wrap };
        readonly TextBlock _roomCode = new TextBlock { FontSize = 15 };
        readonly TextBox _currentInvite = new TextBox
        {
            IsReadOnly = true, TextWrapping = TextWrapping.Wrap, Padding = new Thickness(7),
            FontSize = 12, MinHeight = 28, MaxHeight = 66,
            VerticalScrollBarVisibility = ScrollBarVisibility.Auto
        };
        readonly TextBlock _memberCount = new TextBlock { Margin = new Thickness(0, 6, 0, 4) };
        readonly CheckBox _share = new CheckBox { Content = "共享今日已赚" };
        readonly CheckBox _shareWish = new CheckBox { Content = "共享主程序的心愿进度", Margin = new Thickness(0, 4, 0, 8) };
        readonly ComboBox _targets = new ComboBox { Width = 205, DisplayMemberPath = "ManagementLabel", SelectedValuePath = "id", VerticalAlignment = VerticalAlignment.Center };
        readonly WrapPanel _hostTools = new WrapPanel { Visibility = Visibility.Collapsed };
        RoomMember[] _choices = new RoomMember[0];
        readonly StackPanel _entry = new StackPanel();
        readonly DockPanel _room = new DockPanel { Visibility = Visibility.Collapsed };
        readonly Stopwatch _lastSync = new Stopwatch();
        Uri _server, _inviteBase;
        bool _publicHosted;
        RoomSession _session;
        Task _lastLeaveRequest = Task.CompletedTask;
        RoomSession _syncingSession;
        long _syncSequence;
        bool _pending, _closed, _shuttingDown;

        public RoomWindow(MainWindow main)
        {
            _main = main;
            Title = "联机房间 · 牛马脱敏器";
            Width = 440;
            Height = 430;
            MinWidth = 350;
            MinHeight = 390;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            Background = Ui.B("#F3ECD3");
            FontSize = 14;

            var layout = new DockPanel { Margin = new Thickness(22) };
            Content = layout;
            var heading = new TextBlock { Text = "下班房间", FontSize = 27, FontWeight = FontWeights.SemiBold, Margin = new Thickness(0, 0, 0, 12) };
            DockPanel.SetDock(heading, Dock.Top);
            layout.Children.Add(heading);
            DockPanel.SetDock(_status, Dock.Bottom);
            _status.Margin = new Thickness(0, 8, 0, 0);
            layout.Children.Add(_status);
            var body = new Grid();
            layout.Children.Add(body);
            body.Children.Add(_entry);
            body.Children.Add(_room);

            AddField("服务地址（使用已有服务时填写）", _serverInput);
            AddField("昵称", _name);
            AddField("邀请链接或房间码", _invite);
            var entryActions = new WrapPanel();
            entryActions.Children.Add(Button("创建公网房间", async () => await CreateHosted(true)));
            entryActions.Children.Add(Button("创建本地房间", async () => await CreateHosted(false)));
            entryActions.Children.Add(Button("加入房间", async () => await Enter(false)));
            entryActions.Children.Add(Button("在已有服务建房", async () => await Enter(true)));
            _entry.Children.Add(entryActions);

            var roomControls = new StackPanel();
            _room.Children.Add(new ScrollViewer { Content = roomControls, VerticalScrollBarVisibility = ScrollBarVisibility.Auto });
            roomControls.Children.Add(_roomCode);
            roomControls.Children.Add(_memberCount);
            roomControls.Children.Add(new Label { Content = "邀请链接", Target = _currentInvite, Padding = new Thickness(0, 4, 0, 4) });
            roomControls.Children.Add(_currentInvite);
            var actions = new WrapPanel();
            actions.Children.Add(Button("复制邀请", async () => await CopyInvite()));
            actions.Children.Add(Button("返回计数器", BackToCounters));
            actions.Children.Add(Button("退出房间", async () => await Leave()));
            roomControls.Children.Add(actions);
            _share.Margin = new Thickness(0, 6, 0, 4);
            _share.Checked += (o, e) => Refresh();
            _share.Unchecked += (o, e) => Refresh();
            roomControls.Children.Add(_share);
            roomControls.Children.Add(new TextBlock
            {
                Text = "连续公开的金额可能被用来推算计薪速度。",
                FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, 0, 0, 10)
            });
            _shareWish.Checked += (o, e) => Refresh();
            _shareWish.Unchecked += (o, e) => Refresh();
            roomControls.Children.Add(_shareWish);
            System.Windows.Automation.AutomationProperties.SetName(_targets, "选择要移除的成员");
            _hostTools.Children.Add(_targets);
            _hostTools.Children.Add(Button("移除成员", async () => await Kick()));
            roomControls.Children.Add(_hostTools);
            _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            _timer.Tick += (o, e) => { if (_syncingSession == null) Refresh(); };
            Closing += (o, e) =>
            {
                if (_session == null || _shuttingDown) return;
                e.Cancel = true;
                Dispatcher.BeginInvoke(new Action(BackToCounters));
            };
            Closed += (o, e) =>
            {
                _closed = true;
                _timer.Stop();
            };
            SetMasked(_main.Current.Masked);
        }

        public async Task CloseForShutdown()
        {
            _shuttingDown = true;
            await Leave();
            Close();
        }

        void BackToCounters()
        {
            Hide();
            _main.ShowCounters();
        }

        void AddField(string label, TextBox box)
        {
            _entry.Children.Add(new Label { Content = label, Target = box, Padding = new Thickness(0, 5, 0, 4) });
            box.Padding = new Thickness(7);
            box.Margin = new Thickness(0, 0, 0, 8);
            _entry.Children.Add(box);
        }

        static Button Button(string label, Action action)
        {
            var button = new Button { Content = label, Padding = new Thickness(11, 5, 11, 5), Margin = new Thickness(0, 5, 8, 7) };
            button.Click += (o, e) => action();
            return button;
        }

        public void SetMasked(bool masked)
        {
            _share.IsEnabled = !masked;
            _share.ToolTip = masked ? "桌面防窥已开启" : null;
            if (masked) _share.IsChecked = false;
        }

        static bool AllowedServer(Uri uri)
        {
            return string.IsNullOrEmpty(uri.UserInfo) &&
                (uri.Scheme == Uri.UriSchemeHttps || (uri.Scheme == Uri.UriSchemeHttp && uri.IsLoopback));
        }

        static bool IsPublicTunnel(Uri uri)
        {
            return uri.Scheme == Uri.UriSchemeHttps && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo) &&
                Regex.IsMatch(uri.Host, @"\A(?!api\.)[a-z0-9-]+\.trycloudflare\.com\z", RegexOptions.IgnoreCase);
        }

        static string InviteField(Uri link, string field)
        {
            var fieldPrefix = field + "=";
            foreach (var pair in link.Fragment.TrimStart('#').Split('&'))
                if (pair.StartsWith(fieldPrefix, StringComparison.OrdinalIgnoreCase))
                    return Uri.UnescapeDataString(pair.Substring(fieldPrefix.Length));
            return "";
        }

        async Task Enter(bool create)
        {
            var name = _name.Text.Trim();
            if (name.Length == 0) { _status.Text = "请输入昵称。"; return; }
            var code = _invite.Text.Trim();
            var address = _serverInput.Text.Trim();
            Uri link;
            if (!create && Uri.TryCreate(code, UriKind.Absolute, out link) && AllowedServer(link))
            {
                address = link.GetLeftPart(UriPartial.Authority);
                code = InviteField(link, "room");
                if (string.Equals(address + link.AbsolutePath.TrimEnd('/') + "/", MobileEntry, StringComparison.OrdinalIgnoreCase))
                {
                    Uri tunnel;
                    if (!Uri.TryCreate(InviteField(link, "server"), UriKind.Absolute, out tunnel) || !IsPublicTunnel(tunnel))
                    {
                        _status.Text = "公网邀请链接无效，请重新复制完整链接。";
                        return;
                    }
                    address = tunnel.GetLeftPart(UriPartial.Authority);
                }
            }
            code = code.ToUpperInvariant();
            Uri server;
            if (!Uri.TryCreate(address, UriKind.Absolute, out server) || !AllowedServer(server))
            {
                _status.Text = "请填写 HTTPS 服务地址，或粘贴完整邀请链接。";
                return;
            }
            if (!create && !Regex.IsMatch(code, @"\A[A-F0-9]{12}\z"))
            {
                _status.Text = "请输入好友发来的 12 位房间码。";
                return;
            }

            await RunEntry("正在连接…", () => JoinRoom(server, server, create, name, code, false));
        }

        async Task CreateHosted(bool online)
        {
            var name = _name.Text.Trim();
            if (name.Length == 0) { _status.Text = "请输入昵称。"; return; }
            await RunEntry(online ? "正在申请公网地址，失败会自动重试…" : "正在启动本机房间…", async () =>
            {
                var local = await _main.Host.LocalAddress();
                var invitation = online ? await _main.Host.PublicAddress() : local;
                if (!_closed) await JoinRoom(local, invitation, true, name, "", online);
            });
        }

        async Task RunEntry(string message, Func<Task> connect)
        {
            if (!_entry.IsEnabled) return;
            _entry.IsEnabled = false;
            _status.Text = message;
            try
            {
                await connect();
            }
            catch (Exception error)
            {
                if (!_closed) _status.Text = EntryMessage(error as RoomError);
            }
            finally { _entry.IsEnabled = true; }
        }

        async Task JoinRoom(Uri server, Uri inviteBase, bool create, string name, string code, bool publicHosted)
        {
            var settings = _main.Current;
            if (!Regex.IsMatch(settings.RoomClientKey ?? "", @"\A[a-f0-9]{32}\z"))
            {
                settings.RoomClientKey = Guid.NewGuid().ToString("N");
                settings.Save();
            }
            string clientKey;
            using (var hash = new HMACSHA256(Encoding.UTF8.GetBytes(settings.RoomClientKey)))
                clientKey = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(
                    inviteBase.GetLeftPart(UriPartial.Authority).ToLowerInvariant()))).Replace("-", "").ToLowerInvariant();
            var joined = await RoomApi.Send<RoomSession>(server, create ? "create" : "join",
                new { name, code, clientKey }, null);
            if (_closed)
            {
                await RoomApi.Send<object>(server, "leave", new { }, joined.token);
                return;
            }
            _server = server;
            _inviteBase = inviteBase;
            _publicHosted = publicHosted;
            _serverInput.Text = inviteBase.GetLeftPart(UriPartial.Authority);
            _invite.Text = joined.code;
            _share.IsChecked = false;
            _shareWish.IsChecked = true;
            _syncSequence = 0;
            _session = joined;
            UpdateInviteLink();
            _status.Text = "";
            _main.UpdateRoomCounters(new RoomMember[0], joined.id);
            _roomCode.Text = "房间码  " + joined.code;
            _entry.Visibility = Visibility.Collapsed;
            _room.Visibility = Visibility.Visible;
            _lastSync.Restart();
            _timer.Start();
            Refresh();
        }

        static string EntryMessage(RoomError error)
        {
            switch (error == null ? "" : error.Message)
            {
                case "ROOM_MISSING": return "房间不存在或已过期。";
                case "ROOM_FULL": return "房间已满。";
                case "INVALID_NAME": return "请输入 1 到 24 个字符的昵称。";
                case "TRY_LATER": return "操作过于频繁，请稍后再试。";
                case "MISSING_RUNTIME":
                case "TUNNEL_MISSING_RUNTIME": return "运行组件不完整，请完整解压便携包后再打开 niuma.exe。";
                case "TUNNEL_TIMEOUT": return "Cloudflare 多次申请超时。可以创建本地房间，或稍后重试创建公网房间。";
                case "TUNNEL_UNAVAILABLE": return "Cloudflare 暂时无法建立公网连接。可以创建本地房间或稍后重试。";
                case "LOCAL_TIMEOUT":
                case "LOCAL_START_FAILED":
                case "HOST_STOPPED": return "本机房间服务未能启动，请确认便携包已完整解压后重试。";
                default: return "连接失败，请检查服务地址或网络。";
            }
        }

        internal bool HasRoom { get { return _session != null; } }

        void UpdateInviteLink()
        {
            if (_session == null)
            {
                _currentInvite.Text = "";
                return;
            }
            var room = "#room=" + _session.code;
            _currentInvite.Text = IsPublicTunnel(_inviteBase)
                ? MobileEntry + room + "&server=" + Uri.EscapeDataString(_inviteBase.GetLeftPart(UriPartial.Authority))
                : new Uri(_inviteBase, "/" + room).AbsoluteUri;
        }

        internal async Task<bool> CopyInvite()
        {
            var active = _session;
            if (active == null) return false;
            if (_publicHosted)
            {
                _status.Text = "正在检查公网邀请地址…";
                Uri address;
                try { address = await _main.Host.PublicAddress(); }
                catch (Exception error) { if (_session == active) _status.Text = EntryMessage(error as RoomError); return false; }
                if (_session != active) return false;
                _inviteBase = address;
                UpdateInviteLink();
            }
            try
            {
                Clipboard.SetText(_currentInvite.Text);
                _status.Text = "已复制邀请链接。";
                return true;
            }
            catch (System.Runtime.InteropServices.ExternalException)
            {
                _status.Text = "剪贴板暂时不可用，可在邀请链接栏手动复制。";
                return false;
            }
        }

        Task Leave()
        {
            var active = _session;
            if (active == null) return _lastLeaveRequest;
            var server = _server;
            ReturnToEntry("已退出房间。");
            _lastLeaveRequest = NotifyPreviousRoom(server, active.token);
            return _lastLeaveRequest;
        }

        static async Task NotifyPreviousRoom(Uri server, string token)
        {
            try
            {
                await RoomApi.Send<object>(server, "leave", new { }, token).ConfigureAwait(false);
            }
            catch
            {
                // The local session has already ended. The server handles an unreachable client as offline.
            }
        }

        void ReturnToEntry(string message)
        {
            _session = null;
            _syncingSession = null;
            _pending = false;
            UpdateInviteLink();
            _timer.Stop();
            _share.IsChecked = false;
            _shareWish.IsChecked = false;
            UpdateHostTools(false, new RoomMember[0]);
            _room.Visibility = Visibility.Collapsed;
            _entry.Visibility = Visibility.Visible;
            _main.UpdateRoomCounters(new RoomMember[0], null);
            _status.Text = message;
        }

        Dictionary<string, object> GetSnapshot()
        {
            var settings = _main.Current;
            var snapshot = Engine.Compute(settings, _main.Now());
            var result = new Dictionary<string, object>
            {
                { "state", snapshot.State.ToString() },
                { "progress", Math.Max(0, Math.Min(1, snapshot.Progress)) },
                { "offIn", snapshot.SecondsToOffWork }
            };
            if (_share.IsChecked == true && !settings.Masked &&
                snapshot.Earned >= 0 && !double.IsInfinity(snapshot.Earned))
            {
                var currency = Regex.Replace(settings.Currency ?? "", @"[\x00-\x1f\x7f]", "");
                result.Add("money", new RoomMoney
                {
                    earned = Math.Round(snapshot.Earned, 5),
                    currency = currency.Length <= 16 ? currency : currency.Substring(0, 16)
                });
            }
            if (_shareWish.IsChecked == true)
                result["wish"] = Engine.WishText(settings, snapshot, false);
            return result;
        }

        async Task Kick()
        {
            var active = _session;
            var target = _targets.SelectedValue as string;
            if (active == null || target == null) { _status.Text = "请先选择要移除的成员。"; return; }
            _hostTools.IsEnabled = false;
            try
            {
                await RoomApi.Send<object>(_server, "kick", new { id = target }, active.token);
                if (_session == active) Refresh();
            }
            catch
            {
                if (_session == active) _status.Text = "未能移除成员，请确认仍是房主并重试。";
            }
            finally { _hostTools.IsEnabled = true; }
        }

        void UpdateHostTools(bool host, RoomMember[] members)
        {
            _hostTools.Visibility = host ? Visibility.Visible : Visibility.Collapsed;
            var choices = host ? members.Where(person => person.id != _session.id).ToArray() : new RoomMember[0];
            if (choices.Length == _choices.Length && choices.Zip(_choices,
                (current, previous) => current.id == previous.id && current.name == previous.name &&
                    current.online == previous.online).All(same => same)) return;
            var selected = _targets.SelectedValue;
            _choices = choices;
            _targets.ItemsSource = choices;
            _targets.SelectedValue = selected;
        }

        async void Refresh()
        {
            var active = _session;
            if (active == null || _closed) return;
            if (_syncingSession == active) { _pending = true; return; }
            _syncingSession = active;
            try
            {
                var view = await RoomApi.Send<RoomView>(_server, "sync",
                    new { seq = ++_syncSequence, snapshot = GetSnapshot() }, active.token);
                if (_session != active || _closed) return;
                _lastSync.Restart();
                if (_status.Text == "连接中断，正在重连…") _status.Text = "";
                _memberCount.Text = "房间成员 " + view.members.Length + " 人" + (view.host ? " · 你是房主" : "");
                UpdateHostTools(view.host, view.members);
                _main.UpdateRoomCounters(view.members, active.id);
            }
            catch (Exception error)
            {
                if (_session != active || _closed) return;
                if (error is RoomError && error.Message == "SESSION_EXPIRED")
                    ReturnToEntry("已离开房间或连接已过期。");
                else
                {
                    _status.Text = "连接中断，正在重连…";
                    if (_lastSync.Elapsed.TotalSeconds >= 15)
                        _main.UpdateRoomCounters(new RoomMember[0], null);
                }
            }
            finally
            {
                if (_syncingSession == active)
                {
                    _syncingSession = null;
                    if (_pending) { _pending = false; Refresh(); }
                }
            }
        }
    }
}
