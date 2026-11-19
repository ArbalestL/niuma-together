using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;

namespace NiuMa
{
    internal sealed class RoomCounters : Border
    {
        internal const int CompactFontSize = 15;
        internal const int CompactSoloDecimals = 5;
        internal const int CompactGroupDecimals = 4;
        internal bool ShowingMembers { get { return Visibility == Visibility.Visible; } }
        readonly bool _compact;
        readonly StackPanel _list = new StackPanel();
        readonly TextBlock _waiting;
        readonly Dictionary<string, MemberCounter> _counters = new Dictionary<string, MemberCounter>();
        readonly Dictionary<string, double> _offlineSince = new Dictionary<string, double>();
        bool _active, _onlySelf;

        public RoomCounters(bool compact)
        {
            _compact = compact;
            Visibility = Visibility.Collapsed;
            Margin = new Thickness(0, compact ? 4 : 0, 0, compact ? 0 : 7);
            Padding = new Thickness(0, compact ? 3 : 6, 0, 0);
            BorderBrush = Ui.B("#28000000");
            BorderThickness = new Thickness(0, 1, 0, 0);
            _waiting = Ui.T("已加入联机房间，等好友加入", 12, Ui.Sub);
            _list.Children.Add(_waiting);
            Child = new ScrollViewer
            {
                Content = _list,
                MaxHeight = compact ? 110 : 225,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto
            };
        }

        public void SetOptions(AppSettings settings)
        {
            _onlySelf = _compact && settings.MiniOnlySelf;
            foreach (var counter in _counters.Values) counter.SetOptions(settings);
            UpdateVisibility();
        }

        public bool Update(RoomMember[] members, string self, AppSettings settings, double now)
        {
            bool changed = _active != (self != null);
            _active = self != null;
            var missing = new HashSet<string>(_counters.Keys);
            var onlineNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var member in members)
                if (member.online && member.id != self) onlineNames.Add(member.name);
            var order = new List<MemberCounter>();
            foreach (var member in members.OrderBy(person => person.online ? person.background ? 1 : 0 : 2))
            {
                if (member.id == self || (!member.online && onlineNames.Contains(member.name))) continue;
                if (_compact && (member.backgroundSeconds >= 3600 || HideOffline(member, now))) continue;
                MemberCounter counter;
                if (!_counters.TryGetValue(member.id, out counter))
                {
                    counter = new MemberCounter(_compact);
                    _counters.Add(member.id, counter);
                    _list.Children.Add(counter);
                    changed = true;
                }
                missing.Remove(member.id);
                counter.Update(member, settings, now);
                order.Add(counter);
            }
            foreach (var id in missing)
            {
                _list.Children.Remove(_counters[id]);
                _counters.Remove(id);
                changed = true;
            }
            if (_compact)
            {
                var inactive = new HashSet<string>(members.Where(member => !member.online).Select(member => member.id));
                foreach (var id in _offlineSince.Keys.Where(id => !inactive.Contains(id)).ToArray())
                    _offlineSince.Remove(id);
            }
            for (int i = 0; i < order.Count; i++)
            {
                if (_list.Children[i + 1] == order[i]) continue;
                _list.Children.Remove(order[i]);
                _list.Children.Insert(i + 1, order[i]);
                changed = true;
            }
            UpdateVisibility();
            return changed;
        }

        bool HideOffline(RoomMember member, double now)
        {
            if (member.online) return false;
            if (member.offlineSeconds.HasValue) return member.offlineSeconds.Value >= 180;
            double seen;
            if (!_offlineSince.TryGetValue(member.id, out seen)) _offlineSince[member.id] = seen = now;
            return now - seen >= 180;
        }

        void UpdateVisibility()
        {
            _waiting.Visibility = _counters.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
            Visibility = _active && !_onlySelf && (!_compact || _counters.Count > 0)
                ? Visibility.Visible : Visibility.Collapsed;
        }

        public void Render(double now)
        {
            if (!IsVisible) return;
            foreach (var counter in _counters.Values) counter.Render(now);
        }

        internal static Grid CompactRow(TextBlock name, TextBlock state, TextBlock wish, UIElement amount)
        {
            var row = new Grid { MinHeight = 21 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto, SharedSizeGroup = "MiniName" });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto, SharedSizeGroup = "MiniState" });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto, SharedSizeGroup = "MiniMoney" });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto, SharedSizeGroup = "MiniWish" });
            CompactText(row, name, 0, 72, new Thickness(0, 0, 5, 0));
            CompactText(row, state, 1, 44, new Thickness(0, 0, 4, 0));
            Grid.SetColumn(amount, 2);
            var money = amount as FrameworkElement;
            if (money != null)
            {
                money.VerticalAlignment = VerticalAlignment.Center;
                money.RenderTransform = CompactInkOffset("0", Ui.Num, CompactFontSize, FontWeights.Bold, true);
            }
            row.Children.Add(amount);
            CompactText(row, wish, 3, 152, new Thickness(4, 0, 0, 0));
            return row;
        }

        static void CompactText(Grid row, TextBlock text, int column, double limit, Thickness margin)
        {
            text.TextWrapping = TextWrapping.NoWrap;
            text.TextTrimming = TextTrimming.CharacterEllipsis;
            text.VerticalAlignment = VerticalAlignment.Center;
            text.RenderTransform = CompactInkOffset("田", text.FontFamily, text.FontSize, text.FontWeight, false);
            text.MaxWidth = limit;
            text.Margin = margin;
            Grid.SetColumn(text, column);
            row.Children.Add(text);
        }

        static TranslateTransform CompactInkOffset(string sample, FontFamily font, double size, FontWeight weight, bool roundLine)
        {
            var typeface = new Typeface(font, FontStyles.Normal, weight, FontStretches.Normal);
            var text = new FormattedText(sample, CultureInfo.CurrentUICulture, FlowDirection.LeftToRight,
                typeface, size, Brushes.Black, 1.0);
            var ink = text.BuildGeometry(new Point(0, 0)).Bounds;
            var line = roundLine ? Math.Ceiling(text.Height) : text.Height;
            return new TranslateTransform(0, ink.IsEmpty ? 0 : line / 2 - ink.Top - ink.Height / 2);
        }

        internal static string ShortWish(string wish)
        {
            if (string.IsNullOrEmpty(wish)) return "";
            if (wish == "今天收工，辛苦了。" || wish == "休息日，花钱的事交给明天的自己。" ||
                wish == "今天也是为梦想窝囊的一天。") return "";
            var desktop = Regex.Match(wish, @"^再过 (.+?)，(.+?)就赚回来了。$");
            if (desktop.Success) return desktop.Groups[2].Value + " · " + desktop.Groups[1].Value;
            var phone = Regex.Match(wish, @"^距离赚到(.+?)还要 (.+?)。$");
            if (phone.Success) return phone.Groups[1].Value + " · " + phone.Groups[2].Value;
            var reached = Regex.Match(wish, @"^今天(?:已经|已)赚到(.+?)(?:了，稳住|了，收工)?[。！]$");
            return reached.Success ? "已赚到" + reached.Groups[1].Value : wish;
        }

        sealed class MemberCounter : Grid
        {
            readonly TextBlock _label, _fallback, _details, _mask, _wish;
            readonly Odometer _amount;
            readonly Viewbox _amountFit, _maskFit;
            readonly Grid _value;
            readonly double _counterHeight;
            readonly bool _compact;
            RoomMoney _money;
            double _from, _target, _start, _duration, _sampleAt, _lastRendered = double.NaN;
            bool _masked, _rolling;
            int _decimals;

            public MemberCounter(bool compact)
            {
                _compact = compact;
                Margin = compact ? new Thickness(0, 0, 0, 1) : new Thickness(0, 2, 0, 7);
                _label = Ui.T("", compact ? 11 : 12, Ui.Sub, FontWeights.SemiBold);
                _label.TextWrapping = TextWrapping.NoWrap;
                _label.TextTrimming = TextTrimming.CharacterEllipsis;
                _label.VerticalAlignment = VerticalAlignment.Center;
                _wish = Ui.T("", compact ? 11 : 12, Ui.Leaf);
                _wish.TextWrapping = TextWrapping.Wrap;
                if (!compact) _wish.MaxWidth = 280;
                _wish.Visibility = Visibility.Collapsed;
                _details = Ui.T("", 11, Ui.Sub);
                _value = new Grid { Margin = compact ? new Thickness(0) : new Thickness(0, 2, 0, 2) };
                var size = compact ? CompactFontSize : 40;
                _counterHeight = compact ? 19 : 54;
                _amount = new Odometer(Ui.Num, size, Ui.Carrot);
                _mask = Ui.T("", size, Ui.Carrot, FontWeights.Bold, Ui.Num);
                _amountFit = Fit(_amount, compact);
                _maskFit = Fit(_mask, compact);
                _value.Children.Add(_amountFit);
                _value.Children.Add(_maskFit);
                _fallback = Ui.T("", compact ? 10 : 14, Ui.Sub);
                _fallback.VerticalAlignment = VerticalAlignment.Center;
                _value.Children.Add(_fallback);
                if (compact)
                {
                    Children.Add(CompactRow(_label, _details, _wish, _value));
                }
                else
                {
                    var layout = new DockPanel();
                    Children.Add(layout);
                    DockPanel.SetDock(_label, Dock.Top);
                    DockPanel.SetDock(_wish, Dock.Bottom);
                    DockPanel.SetDock(_details, Dock.Bottom);
                    layout.Children.Add(_label);
                    layout.Children.Add(_wish);
                    layout.Children.Add(_details);
                    layout.Children.Add(_value);
                }
            }

            static Viewbox Fit(UIElement value, bool compact)
            {
                return new Viewbox
                {
                    Child = value, StretchDirection = StretchDirection.DownOnly,
                    MaxWidth = compact ? 103 : 280, HorizontalAlignment = HorizontalAlignment.Left,
                    VerticalAlignment = VerticalAlignment.Center
                };
            }

            public void Update(RoomMember member, AppSettings settings, double now)
            {
                _label.Text = _compact ? member.name : member.name + " 今日已赚" + (member.background ? " · 后台" : "");
                _label.ToolTip = _label.Text;
                var snapshot = member.online ? member.snapshot : null;
                var wish = snapshot == null ? "" : snapshot.wish;
                _wish.Text = _compact ? ShortWish(wish) : wish;
                _wish.ToolTip = wish;
                _wish.Visibility = string.IsNullOrEmpty(_wish.Text) ? Visibility.Collapsed : Visibility.Visible;
                var money = snapshot == null ? null : snapshot.money;
                if (money != null && (double.IsNaN(money.earned) || double.IsInfinity(money.earned) || money.earned < 0))
                    money = null;
                if (money != null)
                {
                    var elapsed = now - _sampleAt;
                    bool sameCurrency = _money != null && _money.currency == money.currency;
                    double value = sameCurrency ? ValueAt(now) : money.earned;
                    if (!sameCurrency || money.earned < _target)
                    {
                        _from = _target = money.earned;
                        _duration = 0;
                    }
                    else if (money.earned > _target)
                    {
                        _from = value;
                        _target = money.earned;
                        _start = now;
                        _duration = Math.Max(0.2, Math.Min(1.0, elapsed));
                    }
                    _sampleAt = now;
                }
                _money = money;
                _details.Text = _compact ? CompactState(member, snapshot) : Details(member, snapshot);
                _details.ToolTip = Details(member, snapshot);
                _fallback.Tag = !member.online ? (_compact ? "—" : "离线") : snapshot == null
                    ? (_compact ? "—" : "未设置班次") : "金额未共享";
                SetOptions(settings);
                Render(now);
            }

            static string CompactState(RoomMember member, MemberSnapshot snapshot)
            {
                if (!member.online) return "离线";
                if (member.background) return "后台";
                if (snapshot == null) return "未设置";
                switch (snapshot.state)
                {
                    case "RestDay": return "休息日";
                    case "BeforeWork": return "待上班";
                    case "Lunch": return "午休中";
                    case "AfterWork": return "已下班";
                    case "Overtime": return "加班中";
                    default: return "上班中";
                }
            }

            static string Details(RoomMember member, MemberSnapshot snapshot)
            {
                if (!member.online || snapshot == null) return "";
                if (snapshot.state == "RestDay") return "休息日";
                if (snapshot.state == "AfterWork") return "已下班";
                if (snapshot.state == "Overtime") return "加班中 · 100%";
                string state = snapshot.state == "Lunch" ? "午休中" :
                    snapshot.state == "BeforeWork" ? "还没上班" : "上班中";
                var result = state + " · " + snapshot.progress.ToString("P1");
                if (snapshot.offIn > 0)
                    result += " · 距下班 " + Engine.Duration(snapshot.offIn, false);
                return result;
            }

            public void SetOptions(AppSettings settings)
            {
                _masked = settings.Masked;
                _rolling = settings.Odometer;
                _decimals = _compact ? CompactGroupDecimals : settings.Decimals;
                bool shared = _money != null;
                _value.MinHeight = shared ? _counterHeight : 0;
                _amountFit.Visibility = shared && !_masked ? Visibility.Visible : Visibility.Collapsed;
                _maskFit.Visibility = shared && _masked ? Visibility.Visible : Visibility.Collapsed;
                _fallback.Visibility = shared ? Visibility.Collapsed : Visibility.Visible;
                _fallback.Text = (string)_fallback.Tag;
                _mask.Text = shared && _masked ? _money.currency + (_compact ? " ****.****" : " ****.**") : "";
                _lastRendered = double.NaN;
            }

            double ValueAt(double now)
            {
                if (_duration <= 0 || now >= _start + _duration) return _target;
                return _from + (_target - _from) * Math.Max(0, now - _start) / _duration;
            }

            public void Render(double now)
            {
                if (_money == null || _masked) return;
                var value = ValueAt(now);
                if (value == _lastRendered) return;
                _lastRendered = value;
                bool rolling = _rolling && value < 1e12;
                _amount.Configure(_money.currency, rolling);
                _amount.SetValue(value, _decimals, _duration > 0 ? (_target - _from) / _duration : 0);
            }
        }
    }
}
