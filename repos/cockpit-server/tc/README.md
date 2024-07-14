# Traffic Control Scripts

## Scripts used by cockpit-server

- set_bandwidth.sh
- delete_iptable_rule.sh

### Setting up bandwidth limit on an interface for moq mode

The name of the interface is hard-coded in the script. Mode can be moq or dash.

```bash
./set_bandwidth.sh moq 1000000
```

### Deleting bandwidth limit for moq mode

```bash
./set_bandwidth.sh moq 0 del
```

### Clear all rules on interface wlo1

```bash
./clear_all.sh wlo1
```

## Some useful commands

### Watching class traffic on interface wlo1

```bash
watch /sbin/tc -s -d class show dev wlo1
```

### Checking qdisc, class, filter, and iptables rules

```bash
tc filter show dev wlo1
tc class show dev wlo1
tc qdisc show dev wlo1
iptables -L OUTPUT -t mangle -n -v
``````

To analyze the traffic on interfaces, `iptraf` can be used.
