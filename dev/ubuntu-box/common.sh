# Shared by the dev/ubuntu-box scripts.
BOX=dokploy-ubuntu
REPO="registry.test:5000/dokploy"
TAG="${DOKPLOY_TEST_TAG:-auto}"

log() { printf '\033[1;34m[ubuntu-box]\033[0m %s\n' "$*"; }
in_box() { docker exec -i "$BOX" bash -c "$1"; }

# The box has no systemd: dockerd is started by hand, after the cgroup v2
# nesting that docker:dind does in its entrypoint.
start_dockerd() {
	in_box '
if [ -f /sys/fs/cgroup/cgroup.controllers ] && [ ! -d /sys/fs/cgroup/init ]; then
	mkdir -p /sys/fs/cgroup/init
	xargs -rn1 </sys/fs/cgroup/cgroup.procs >/sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
	sed -e "s/ / +/g" -e "s/^/+/" </sys/fs/cgroup/cgroup.controllers >/sys/fs/cgroup/cgroup.subtree_control
fi
pgrep -x dockerd >/dev/null || nohup dockerd >/var/log/dockerd.log 2>&1 &
for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && exit 0; sleep 1; done
tail -20 /var/log/dockerd.log; exit 1'
}

# registry.test is the box itself, for its Docker and for the panel.
add_registry_host() {
	in_box '
ip=$(ip -4 route get 1.1.1.1 | awk "{for (i = 1; i < NF; i++) if (\$i == \"src\") print \$(i + 1)}")
grep -q " registry.test$" /etc/hosts || echo "$ip registry.test" >>/etc/hosts
echo "$ip" >/etc/dokploy/test-box-ip'
}
