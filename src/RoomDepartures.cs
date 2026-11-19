using System;
using System.Collections.Generic;
using System.Linq;

namespace NiuMa
{
    internal sealed class RoomDepartures
    {
        readonly Dictionary<string, string> _states = new Dictionary<string, string>();

        internal List<string> Observe(RoomMember[] members)
        {
            var remaining = new HashSet<string>(members.Select(member => member.id));
            foreach (var id in _states.Keys.Where(id => !remaining.Contains(id)).ToArray()) _states.Remove(id);
            var messages = new List<string>();
            foreach (var member in members)
            {
                if (!member.online || member.snapshot == null) continue;
                string previous;
                var current = member.snapshot.state;
                if (current == "AfterWork" && _states.TryGetValue(member.id, out previous) &&
                    (previous == "Working" || previous == "Lunch" || previous == "Overtime"))
                    messages.Add("【" + member.name + "】下班了！拜拜了您");
                _states[member.id] = current;
            }
            return messages;
        }
    }
}
