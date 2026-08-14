---
name: linux-admin
version: 1.0.0
description: Linux system administration for KHY-Quant OS deployment — systemd services, networking, disk management, security hardening. Triggered for system management tasks.
layer: system
lifecycle: operations
tags: [linux, sysadmin, systemd, networking, filesystem, security]
platforms: [khy-quant, claude-code, cosh]
dependencies: []
---

# Linux System Administration

System management skill for KHY-Quant OS deployments.

## When to Activate

- User manages systemd services (start/stop/enable/disable)
- User configures networking (firewall, DNS, ports)
- User manages disk, filesystems, or storage
- User asks about system resource monitoring
- User performs security hardening or user management

## Core Principles

1. **Least privilege** — run services as dedicated users, not root
2. **Idempotent scripts** — running twice produces the same result
3. **Audit trail** — log all configuration changes

## Common Tasks

### Service Management
```bash
# KHY-Quant backend service
sudo systemctl status khy-backend
sudo systemctl restart khy-backend
journalctl -u khy-backend -f --no-pager
```

### Port Management
```bash
# Check what's using a port
ss -tlnp | grep :3000
# Open firewall port
sudo firewall-cmd --add-port=3000/tcp --permanent
sudo firewall-cmd --reload
```

### Disk Usage
```bash
df -h
du -sh /home/*/KHY-Quant* 2>/dev/null
```

### Process Monitoring
```bash
# Find Node.js processes
pgrep -af node
# System resource overview
top -bn1 | head -20
```

## Safety Rules

- Never run `rm -rf /` or delete system directories
- Always back up config files before modifying
- Use `--dry-run` flags when available
- Check disk space before large operations
