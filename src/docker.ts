/**
 * Docker Compose Backend for Connectome MCP
 *
 * Manages Docker Compose services via shell commands (docker stats, docker ps,
 * docker logs, docker restart, docker compose up).
 *
 * The docker-compose project root is /opt/connectome.
 */

import { exec as execCb } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execCb);

const COMPOSE_DIR = '/opt/connectome';

/** Timeout for quick commands (status, logs) */
const SHORT_TIMEOUT = 30_000;

/** Timeout for restart */
const RESTART_TIMEOUT = 120_000;

/** Timeout for rebuild (docker compose up --build) */
const REBUILD_TIMEOUT = 300_000;

interface ExecResult {
  stdout: string;
  stderr: string;
}

async function run(cmd: string, timeoutMs: number): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await exec(cmd, {
      cwd: COMPOSE_DIR,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err: any) {
    // exec rejects on non-zero exit or timeout — still return output
    return {
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || err.message || '').trim(),
    };
  }
}

/**
 * Extract meaningful lines from docker compose stderr output.
 * Filters out build cache noise and warnings, keeps Built/Started/Running/etc.
 */
function summarizeDockerOutput(stderr: string): string {
  if (!stderr) return '';
  return stderr
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      // Skip warnings and build noise
      if (trimmed.startsWith('time=')) return false;
      // Keep container state lines (Built, Started, Running, Recreated, etc.)
      return /^\s*Container\s+/.test(line) || /^\s*connectome-/.test(line);
    })
    .join('\n');
}

export class DockerBackend {
  // ── Tool implementations ──────────────────────────────────────

  /**
   * docker_status — list all containers with status, memory, uptime
   */
  async status(): Promise<string> {
    // Get container list with state info
    const psResult = await run(
      'docker ps -a --format \'{"name":"{{.Names}}","status":"{{.Status}}","state":"{{.State}}","image":"{{.Image}}","ports":"{{.Ports}}"}\'',
      SHORT_TIMEOUT,
    );

    // Get live stats (only running containers)
    const statsResult = await run(
      'docker stats --no-stream --format \'{"name":"{{.Name}}","cpu":"{{.CPUPerc}}","mem":"{{.MemUsage}}","memPerc":"{{.MemPerc}}","net":"{{.NetIO}}","block":"{{.BlockIO}}","pids":"{{.PIDs}}"}\'',
      SHORT_TIMEOUT,
    );

    // Parse ps output (one JSON object per line)
    const containers: any[] = [];
    for (const line of psResult.stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        containers.push(JSON.parse(line));
      } catch { /* skip malformed lines */ }
    }

    // Parse stats into a lookup by name
    const statsMap = new Map<string, any>();
    for (const line of statsResult.stdout.split('\n')) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line);
        statsMap.set(s.name, s);
      } catch { /* skip */ }
    }

    // Merge stats into container list
    const merged = containers.map((c) => {
      const stats = statsMap.get(c.name);
      return {
        name: c.name,
        state: c.state,
        status: c.status,
        image: c.image,
        ports: c.ports || undefined,
        cpu: stats?.cpu || undefined,
        memory: stats?.mem || undefined,
        memoryPercent: stats?.memPerc || undefined,
        network: stats?.net || undefined,
        pids: stats?.pids || undefined,
      };
    });

    // Sort: running first, then by name
    merged.sort((a, b) => {
      if (a.state !== b.state) return a.state === 'running' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return JSON.stringify({
      totalContainers: merged.length,
      running: merged.filter((c) => c.state === 'running').length,
      stopped: merged.filter((c) => c.state !== 'running').length,
      containers: merged,
    }, null, 2);
  }

  /**
   * docker_logs — get logs from a specific container
   */
  async logs(params: { service: string; lines?: number; since?: string }): Promise<string> {
    const service = params.service;
    const lines = params.lines || 50;

    // Build the docker logs command
    let cmd = `docker logs --tail ${lines}`;
    if (params.since) {
      cmd += ` --since ${params.since}`;
    }
    cmd += ` ${service}`;

    const result = await run(cmd, SHORT_TIMEOUT);

    // docker logs sends stdout and stderr separately — combine
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');

    return JSON.stringify({
      service,
      lines,
      since: params.since || undefined,
      output,
    }, null, 2);
  }

  /**
   * docker_restart — restart one or more services, optionally with rebuild and/or cascade
   */
  async restart(params: {
    services: string[];
    rebuild?: boolean;
    cascade?: boolean;
  }): Promise<string> {
    let services = [...params.services];

    // Cascade logic: if any service matches "axon" or "connectome", also restart all bot-* containers
    if (params.cascade) {
      const needsCascade = services.some(
        (s) => s.includes('axon') || s === 'connectome',
      );
      if (needsCascade) {
        // Discover all bot-* containers (including stopped)
        const psResult = await run(
          'docker ps -a --format "{{.Names}}" --filter "name=bot-"',
          SHORT_TIMEOUT,
        );
        const botContainers = psResult.stdout
          .split('\n')
          .map((s) => s.trim())
          .filter((s) => s.startsWith('bot-'));

        // Add bot containers that are not already in the list
        for (const bot of botContainers) {
          if (!services.includes(bot)) {
            services.push(bot);
          }
        }
      }
    }

    const timeout = params.rebuild ? REBUILD_TIMEOUT : RESTART_TIMEOUT;

    // Separate infrastructure services (connectome, axons) from dependents (bots)
    // Infrastructure must be restarted first and healthy before dependents
    const infra = services.filter((s) => s === 'connectome' || s.includes('axon'));
    const dependents = services.filter((s) => !infra.includes(s));

    const results: ExecResult[] = [];

    const buildFlag = params.rebuild ? ' --build' : '';

    // Always use `docker compose up -d` — handles both stopped and running containers
    if (infra.length > 0) {
      results.push(await run(`docker compose up -d${buildFlag} ${infra.join(' ')}`, timeout));
      if (dependents.length > 0) {
        await this.waitForHealthy(infra, 60_000);
      }
    }
    if (dependents.length > 0) {
      results.push(await run(`docker compose up -d${buildFlag} ${dependents.join(' ')}`, timeout));
    }

    // stderr has the useful summary (Built, Started, Running, etc.)
    // stdout has verbose Docker build logs — summarize instead of dumping
    const stderr = results.map((r) => r.stderr).filter(Boolean).join('\n');
    const summary = summarizeDockerOutput(stderr);

    return JSON.stringify({
      action: params.rebuild ? 'rebuild' : 'restart',
      services,
      cascade: params.cascade || false,
      infraFirst: infra,
      dependents,
      summary,
    }, null, 2);
  }

  /**
   * docker_rebuild_all — full rebuild of all services
   */
  async rebuildAll(): Promise<string> {
    const result = await run(
      'docker compose up -d --build',
      REBUILD_TIMEOUT,
    );

    const summary = summarizeDockerOutput(result.stderr);

    return JSON.stringify({
      action: 'rebuild_all',
      summary,
    }, null, 2);
  }

  /**
   * docker_stop_bots — emergency stop all bot-* containers
   */
  async stopBots(): Promise<string> {
    const psResult = await run(
      'docker ps --format "{{.Names}}" --filter "name=bot-"',
      SHORT_TIMEOUT,
    );
    const bots = psResult.stdout.split('\n').map((s) => s.trim()).filter(Boolean);

    if (bots.length === 0) {
      return JSON.stringify({ action: 'stop_bots', stopped: [], message: 'No running bot containers found' }, null, 2);
    }

    await run(`docker stop ${bots.join(' ')}`, RESTART_TIMEOUT);

    return JSON.stringify({ action: 'stop_bots', stopped: bots }, null, 2);
  }

  /**
   * Poll until all named containers report "healthy" or timeout expires.
   */
  private async waitForHealthy(services: string[], timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { stdout } = await run(
        `docker inspect --format '{{.Name}} {{.State.Health.Status}}' ${services.join(' ')}`,
        SHORT_TIMEOUT,
      );
      const lines = stdout.split('\n').filter(Boolean);
      const allHealthy = lines.length >= services.length &&
        lines.every((line) => line.includes('healthy') && !line.includes('unhealthy'));
      if (allHealthy) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
    // Timeout — proceed anyway so dependents still get restarted
  }

  // ── Tool dispatch ─────────────────────────────────────────────

  async callTool(name: string, args: any): Promise<string> {
    switch (name) {
      case 'docker_status': return this.status();
      case 'docker_logs': return this.logs(args);
      case 'docker_restart': return this.restart(args);
      case 'docker_rebuild_all': return this.rebuildAll();
      case 'docker_stop_bots': return this.stopBots();
      default: throw new Error(`Unknown docker tool: ${name}`);
    }
  }
}
