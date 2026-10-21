#!/usr/bin/env bash
# A network namespace that behaves like a phone on the household mesh over cellular:
# RTT and bandwidth applied with netem on a veth pair, so TCP/TLS handshakes and slow start are real.
# The host side forwards :443 to the mesh entrance (which only talks on lo/hs0) through socat.
# Usage (root): phone-netns.sh up [RTT_MS] [DOWN_MBIT] [UP_MBIT] | down
set -euo pipefail
NS=kenan-phone HOST_IF=kphone0 NS_IF=kphone1 HOST_IP=10.211.0.1 NS_IP=10.211.0.2 ENTRANCE=100.64.0.1
case "${1:-}" in
  up)
    rtt=${2:-300} down=${3:-5} up=${4:-1.5} half=$(( ${2:-300} / 2 ))
    "$0" down >/dev/null 2>&1 || true
    ip netns add $NS
    ip link add $HOST_IF type veth peer name $NS_IF
    ip link set $NS_IF netns $NS
    ip addr add $HOST_IP/30 dev $HOST_IF; ip link set $HOST_IF up
    ip -n $NS addr add $NS_IP/30 dev $NS_IF; ip -n $NS link set $NS_IF up; ip -n $NS link set lo up
    ip -n $NS route add default via $HOST_IP
    # Static neighbours: ARP over a delayed link would add a round trip to the first connection.
    ip neigh replace $NS_IP lladdr "$(ip -n $NS -br link show $NS_IF | awk '{print $3}')" dev $HOST_IF nud permanent
    ip -n $NS neigh replace $HOST_IP lladdr "$(ip -br link show $HOST_IF | awk '{print $3}')" dev $NS_IF nud permanent
    tc qdisc add dev $HOST_IF root netem delay ${half}ms rate ${down}mbit limit 1000
    ip netns exec $NS tc qdisc add dev $NS_IF root netem delay ${half}ms rate ${up}mbit limit 1000
    systemd-run --unit kenan-phone-forward --collect -q socat TCP-LISTEN:443,bind=$HOST_IP,fork,reuseaddr,nodelay TCP:$ENTRANCE:443,nodelay
    echo "kenan-phone: RTT ${rtt}ms, ${down}/${up} Mbit; resolve *.mesh.example.com to $HOST_IP" ;;
  down)
    systemctl stop kenan-phone-forward 2>/dev/null || true
    ip link del $HOST_IF 2>/dev/null || true
    ip netns del $NS 2>/dev/null || true ;;
  *) echo "usage: $0 up [RTT_MS] [DOWN_MBIT] [UP_MBIT] | down" >&2; exit 2 ;;
esac
