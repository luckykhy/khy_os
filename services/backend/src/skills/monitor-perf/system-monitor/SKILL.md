---
name: system-monitor
version: 1.0.0
description: System monitoring and performance tuning — CPU, memory, disk, network, and process metrics. Triggered when user asks about system health or performance.
layer: system
lifecycle: operations
category: monitor-perf
tags: [monitoring, performance, cpu, memory, disk, network, metrics]
platforms: [khy-quant, claude-code, cosh]
dependencies: []
---

# System Monitor Skill

Real-time system health monitoring and performance diagnostics.

## When to Activate

- User asks about system resource usage (CPU, memory, disk)
- User reports slow performance or high load
- User wants to monitor a specific process
- User asks about network throughput or connections
- User wants to set up alerting thresholds

## Monitoring Pipeline

### Step 1: Quick Health Check
```bash
# One-liner system overview
uptime && free -h && df -h / && echo "---" && ps aux --sort=-%mem | head -6
```

### Step 2: Deep Diagnostics

#### CPU Analysis
```bash
# Per-core utilization
mpstat -P ALL 1 3 2>/dev/null || top -bn1 | head -5
# Top CPU consumers
ps aux --sort=-%cpu | head -10
```

#### Memory Analysis
```bash
# Detailed memory breakdown
free -h
cat /proc/meminfo | head -20 2>/dev/null
# Top memory consumers
ps aux --sort=-%mem | head -10
```

#### Disk I/O
```bash
# I/O statistics
iostat -x 1 3 2>/dev/null || df -h
# Find large files
du -sh /home/*/Khy-OS* 2>/dev/null
```

#### Network
```bash
# Active connections
ss -tunp | head -20
# Network interface stats
ip -s link 2>/dev/null || netstat -i
```

### Step 3: KHY-Quant Specific
```bash
# Node.js process health
pgrep -af "node.*khy" | head -5
# Backend API response time
curl -o /dev/null -s -w "%{time_total}s" http://localhost:3000/api/health 2>/dev/null
# Database connection check
ls -la ~/.khyquant/data/*.db 2>/dev/null
```

### Step 4: Recommendations
Based on findings, suggest:
- Resource bottlenecks and fixes
- Process optimization (restart, reconfigure)
- Capacity planning advice

## Alert Thresholds
- CPU > 80% sustained: warning
- Memory > 85%: warning
- Disk > 90%: critical
- Load average > 2x CPU cores: warning

## Cross-Platform Notes
- Linux: full /proc, systemd, ss support
- macOS: use `vm_stat`, `diskutil`, `lsof`
- Windows: use `Get-Process`, `Get-Counter`, `wmic`

## Safety Rules

- Read-only operations only — never kill processes without confirmation
- Respect user privacy — do not inspect process arguments that may contain secrets
- Use `-n` / `--no-dns` flags to avoid slow DNS lookups
