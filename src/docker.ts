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

const COMPOSE_DIR = process.env.COMPOSE_DIR || '/opt/connectome';

/** Timeout for quick commands (status, logs) */
const SHORT_TIMEOUT = 30_000;

/** Timeout for restart */
const RESTART_TIMEOUT = 120_000;

/** Timeout for rebuild (docker compose up --build) */
const REBUILD_TIMEOUT = 600_000;

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
    callerBot?: string;
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

    // Deferred self-restart: if callerBot is in the list, remove it from the
    // immediate restart and schedule it after a delay so the response gets delivered.
    const callerBot = params.callerBot;
    let deferredSelf = false;
    if (callerBot && services.includes(callerBot)) {
      services = services.filter((s) => s !== callerBot);
      deferredSelf = true;
    }

    const timeout = params.rebuild ? REBUILD_TIMEOUT : RESTART_TIMEOUT;

    // Separate infrastructure services (connectome, axons) from dependents (bots)
    // Infrastructure must be restarted first and healthy before dependents
    const infra = services.filter((s) => s === 'connectome' || s.includes('axon'));
    const dependents = services.filter((s) => !infra.includes(s));

    const results: ExecResult[] = [];

    const buildFlag = params.rebuild ? ' --build' : '';
    // Force recreate ensures config changes (bind-mounted files) take effect
    // even when the image hash hasn't changed
    const recreateFlag = ' --force-recreate';

    // Always use `docker compose up -d` — handles both stopped and running containers
    if (infra.length > 0) {
      results.push(await run(`docker compose up -d${buildFlag}${recreateFlag} ${infra.join(' ')}`, timeout));
      if (dependents.length > 0) {
        await this.waitForHealthy(infra, 180_000);
      }
    }
    if (dependents.length > 0) {
      results.push(await run(`docker compose up -d${buildFlag}${recreateFlag} ${dependents.join(' ')}`, timeout));
    }

    // stderr has the useful summary (Built, Started, Running, etc.)
    // stdout has verbose Docker build logs — summarize instead of dumping
    const stderr = results.map((r) => r.stderr).filter(Boolean).join('\n');
    const summary = summarizeDockerOutput(stderr);

    // Schedule deferred self-restart (5s delay for response delivery)
    if (deferredSelf && callerBot) {
      const buildFlag = params.rebuild ? ' --build' : '';
      const selfTimeout = params.rebuild ? REBUILD_TIMEOUT : RESTART_TIMEOUT;
      console.log(`[Docker] Scheduling deferred self-restart for ${callerBot} in 5s`);
      setTimeout(() => {
        run(`docker compose up -d${buildFlag} --force-recreate ${callerBot}`, selfTimeout)
          .then(() => console.log(`[Docker] Deferred self-restart of ${callerBot} complete`))
          .catch((err) => console.error(`[Docker] Deferred self-restart of ${callerBot} failed:`, err.message));
      }, 5000);
    }

    return JSON.stringify({
      action: params.rebuild ? 'rebuild' : 'restart',
      services: [...services, ...(deferredSelf && callerBot ? [`${callerBot} (deferred 5s)`] : [])],
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

  /**
   * docker_diagnose — comprehensive system diagnostics
   */
  async diagnose(params: { since?: string }): Promise<string> {
    const since = params.since || '5m';

    // 1. Container status summary
    const psResult = await run(
      'docker ps -a --format \'{{.Names}}\t{{.State}}\t{{.Status}}\'',
      SHORT_TIMEOUT,
    );
    const containers: { name: string; state: string; status: string }[] = [];
    for (const line of psResult.stdout.split('\n')) {
      if (!line.trim()) continue;
      const [name, state, status] = line.split('\t');
      if (name) containers.push({ name, state, status });
    }
    const running = containers.filter((c) => c.state === 'running');
    const stopped = containers.filter((c) => c.state !== 'running');

    // 2. Signal-CLI health check
    let signalCliHealth: { ok: boolean; detail: string };
    try {
      const signalResult = await run(
        'docker exec signal-cli curl -sf http://localhost:8080/v1/about',
        SHORT_TIMEOUT,
      );
      signalCliHealth = {
        ok: signalResult.stdout.length > 0,
        detail: signalResult.stdout || signalResult.stderr || 'no response',
      };
    } catch {
      signalCliHealth = { ok: false, detail: 'signal-cli container not reachable' };
    }

    // 3. Parse recent logs from key services for errors
    const errorServices = ['signal-axon', 'discord-axon', 'connectome'];
    const errorPatterns: { service: string; errors: string[] }[] = [];
    for (const svc of errorServices) {
      const logResult = await run(
        `docker logs --since ${since} ${svc} 2>&1`,
        SHORT_TIMEOUT,
      );
      const allLines = logResult.stdout.split('\n').concat(logResult.stderr.split('\n'));
      const errors = allLines.filter((line) =>
        /\bError\b|ERR\b|FATAL|panic|exception|unhandled|ECONNREFUSED|ENOTFOUND|timeout.*exceed/i.test(line) &&
        !/error.?tracking.?enabled|error_count[=:]\s*0/i.test(line),
      ).slice(-10); // last 10 error lines
      errorPatterns.push({ service: svc, errors });
    }

    // 4. Sample up to 3 bot containers for subscription churn and API errors
    const botContainers = running
      .filter((c) => c.name.startsWith('bot-'))
      .slice(0, 3);
    const botSamples: { name: string; subscriptionChurn: string[]; apiErrors: string[] }[] = [];
    for (const bot of botContainers) {
      const logResult = await run(
        `docker logs --since ${since} ${bot.name} 2>&1`,
        SHORT_TIMEOUT,
      );
      const allLines = logResult.stdout.split('\n').concat(logResult.stderr.split('\n'));
      const subscriptionChurn = allLines.filter((line) =>
        /subscribe|unsubscribe|reconnect|resubscri|stream.*lost|GOAWAY/i.test(line),
      ).slice(-5);
      const apiErrors = allLines.filter((line) =>
        /API.*error|rate.?limit|\b429\b|\b500\b|\b502\b|\b503\b|\b504\b|overloaded|capacity/i.test(line) &&
        !/Advertised|binding|Connected to/i.test(line),
      ).slice(-5);
      botSamples.push({ name: bot.name, subscriptionChurn, apiErrors });
    }

    // 5. Build recommendations
    const recommendations: string[] = [];

    if (stopped.length > 0) {
      recommendations.push(
        `${stopped.length} container(s) stopped: ${stopped.map((c) => c.name).join(', ')}. Consider restarting.`,
      );
    }

    if (!signalCliHealth.ok) {
      recommendations.push('Signal CLI is not healthy. Check signal-cli container and restart if needed.');
    }

    for (const svc of errorPatterns) {
      if (svc.errors.length > 0) {
        recommendations.push(
          `${svc.service} has ${svc.errors.length} recent error(s) in the last ${since}. Check logs for details.`,
        );
      }
    }

    for (const bot of botSamples) {
      if (bot.subscriptionChurn.length > 3) {
        recommendations.push(
          `${bot.name} shows subscription churn (${bot.subscriptionChurn.length} events). May need restart with cascade.`,
        );
      }
      if (bot.apiErrors.length > 0) {
        recommendations.push(
          `${bot.name} has ${bot.apiErrors.length} API error(s). Check rate limits or provider status.`,
        );
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('No issues detected. System appears healthy.');
    }

    return JSON.stringify({
      since,
      containers: {
        total: containers.length,
        running: running.length,
        stopped: stopped.length,
        stoppedNames: stopped.map((c) => c.name),
      },
      signalCli: signalCliHealth,
      errors: errorPatterns.map((e) => ({
        service: e.service,
        count: e.errors.length,
        recent: e.errors.slice(-3),
      })),
      botSamples: botSamples.map((b) => ({
        name: b.name,
        subscriptionChurnCount: b.subscriptionChurn.length,
        apiErrorCount: b.apiErrors.length,
        recentChurn: b.subscriptionChurn.slice(-2),
        recentApiErrors: b.apiErrors.slice(-2),
      })),
      recommendations,
    }, null, 2);
  }

  // ── Tool dispatch ─────────────────────────────────────────────

  async callTool(name: string, args: any): Promise<string> {
    switch (name) {
      case 'docker_status': return this.status();
      case 'docker_logs': return this.logs(args);
      case 'docker_restart': return this.restart(args);
      case 'docker_rebuild_all': return this.rebuildAll();
      case 'docker_stop_bots': return this.stopBots();
      case 'docker_diagnose': return this.diagnose(args);
      default: throw new Error(`Unknown docker tool: ${name}`);
    }
  }
}
