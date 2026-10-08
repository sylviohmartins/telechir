import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import {
  DashboardApiError,
  decideApproval,
  getOverview,
  revokeDevice,
} from "./api";
import type {
  ApprovalSummary,
  CommandSummary,
  DashboardOverview,
  DeviceSummary,
} from "./types";

const TOKEN_KEY = "telechir.dashboard.access_token";

function formatDate(value: string | null): string {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat("pt-BR", {
        dateStyle: "short",
        timeStyle: "medium",
      }).format(date);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let amount = value / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return `${amount.toFixed(amount >= 10 ? 1 : 2)} ${units[index]}`;
}

function statusClass(status: string): string {
  return status.toLowerCase().replace(/[^a-z0-9]+/gu, "-");
}

function SignIn({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [token, setToken] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = token.trim();
    if (trimmed) {
      onSubmit(trimmed);
      setToken("");
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="login-title">
        <p className="eyebrow">Telechir</p>
        <h1 id="login-title">Dashboard operacional</h1>
        <p>
          Informe um access token OAuth válido. O token fica apenas nesta aba e
          nunca é enviado em telemetria ou exibido após a autenticação.
        </p>
        <form onSubmit={submit}>
          <label htmlFor="access-token">Access token</label>
          <input
            id="access-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
          />
          <button type="submit">Abrir dashboard</button>
        </form>
      </section>
    </main>
  );
}

function DeviceCard({
  device,
  onRevoke,
  busy,
}: {
  device: DeviceSummary;
  onRevoke: (device: DeviceSummary) => void;
  busy: boolean;
}) {
  return (
    <article className="card device-card">
      <div className="card-heading">
        <div>
          <h3>{device.name}</h3>
          <p className="muted">{device.device_id}</p>
        </div>
        <span className={`status ${statusClass(device.status)}`}>
          {device.status}
        </span>
      </div>
      <dl className="facts">
        <div>
          <dt>Sistema</dt>
          <dd>
            {device.os} · {device.arch}
          </dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{device.agent_version}</dd>
        </div>
        <div>
          <dt>Último contato</dt>
          <dd>{formatDate(device.last_seen)}</dd>
        </div>
        <div>
          <dt>Workspace padrão</dt>
          <dd>{device.default_workspace_id}</dd>
        </div>
        <div>
          <dt>Workspaces ativos</dt>
          <dd>{device.active_workspace_count}</dd>
        </div>
      </dl>
      <button
        type="button"
        className="danger secondary"
        disabled={busy}
        onClick={() => onRevoke(device)}
      >
        Revogar device
      </button>
    </article>
  );
}

function ApprovalCard({
  approval,
  onDecision,
  busy,
}: {
  approval: ApprovalSummary;
  onDecision: (approval: ApprovalSummary, decision: "APPROVE" | "DENY") => void;
  busy: boolean;
}) {
  const pending =
    approval.decision === null &&
    approval.consumed_at === null &&
    new Date(approval.expires_at).getTime() > Date.now();

  return (
    <article className="card approval-card">
      <div className="card-heading">
        <div>
          <h3>{approval.tool_name ?? "Operação protegida"}</h3>
          <p className="muted">
            {approval.human_summary} · {approval.device_name}
          </p>
        </div>
        <span className={`risk ${statusClass(approval.risk)}`}>
          {approval.risk}
        </span>
      </div>
      <dl className="facts compact">
        <div>
          <dt>Permissão</dt>
          <dd>{approval.permission}</dd>
        </div>
        <div>
          <dt>Sessão</dt>
          <dd>{approval.session_id}</dd>
        </div>
        <div>
          <dt>Expira</dt>
          <dd>{formatDate(approval.expires_at)}</dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>
            {pending
              ? "pendente"
              : (approval.decision ??
                (approval.consumed_at ? "consumido" : "expirado"))}
          </dd>
        </div>
      </dl>
      {pending ? (
        <div className="actions">
          <button
            type="button"
            disabled={busy}
            onClick={() => onDecision(approval, "APPROVE")}
          >
            Aprovar uma vez
          </button>
          <button
            type="button"
            className="danger secondary"
            disabled={busy}
            onClick={() => onDecision(approval, "DENY")}
          >
            Negar
          </button>
        </div>
      ) : null}
    </article>
  );
}

function CommandRowView({ command }: { command: CommandSummary }) {
  return (
    <tr>
      <td>
        <strong>{command.tool_name}</strong>
        <span className="table-subtitle">{command.operation}</span>
      </td>
      <td>{command.device_name}</td>
      <td>
        <strong>{command.workspace_name}</strong>
        <span className="table-subtitle">
          {command.workspace_id}
          {command.workspace_fencing_token === null
            ? ""
            : ` · fence ${command.workspace_fencing_token}`}
        </span>
      </td>
      <td>
        <span className={`status ${statusClass(command.state)}`}>
          {command.state}
        </span>
      </td>
      <td>{command.risk}</td>
      <td>{formatDate(command.requested_at)}</td>
      <td>{command.error_code ?? "—"}</td>
    </tr>
  );
}

export function App() {
  const [token, setToken] = useState(
    () => sessionStorage.getItem(TOKEN_KEY) ?? "",
  );
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setOverview(await getOverview(token));
    } catch (cause) {
      if (cause instanceof DashboardApiError && cause.status === 401) {
        sessionStorage.removeItem(TOKEN_KEY);
        setToken("");
        setOverview(null);
        setError("Sessão inválida ou expirada.");
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : "Falha ao carregar dashboard.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingApprovals = useMemo(
    () =>
      overview?.approvals.filter(
        (item) =>
          item.decision === null &&
          item.consumed_at === null &&
          new Date(item.expires_at).getTime() > Date.now(),
      ) ?? [],
    [overview],
  );

  function signIn(nextToken: string) {
    sessionStorage.setItem(TOKEN_KEY, nextToken);
    setToken(nextToken);
  }

  function signOut() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken("");
    setOverview(null);
    setError(null);
  }

  async function handleDecision(
    approval: ApprovalSummary,
    decision: "APPROVE" | "DENY",
  ) {
    setBusyId(approval.id);
    setError(null);
    try {
      await decideApproval(token, approval.id, decision, "once");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Falha ao decidir approval.",
      );
    } finally {
      setBusyId(null);
    }
  }

  async function handleRevoke(device: DeviceSummary) {
    const confirmed = window.confirm(
      `Revogar "${device.name}"? O device e suas chaves serão invalidados e a conexão realtime será encerrada.`,
    );
    if (!confirmed) {
      return;
    }
    setBusyId(device.device_id);
    setError(null);
    try {
      await revokeDevice(token, device.device_id);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Falha ao revogar device.",
      );
    } finally {
      setBusyId(null);
    }
  }

  if (!token) {
    return <SignIn onSubmit={signIn} />;
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Telechir</p>
          <h1>Operations dashboard</h1>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="secondary"
            disabled={loading}
            onClick={() => void load()}
          >
            Atualizar
          </button>
          <button type="button" className="secondary" onClick={signOut}>
            Encerrar sessão
          </button>
        </div>
      </header>

      {error ? (
        <div className="alert" role="alert">
          {error}
        </div>
      ) : null}

      {loading && !overview ? (
        <main className="empty-state" aria-live="polite">
          Carregando estado operacional…
        </main>
      ) : null}

      {overview ? (
        <main className="dashboard">
          <section className="metrics" aria-label="Resumo de uso">
            <article>
              <span>Tool calls</span>
              <strong>{overview.usage.tool_calls}</strong>
            </article>
            <article>
              <span>Concluídos</span>
              <strong>{overview.usage.completed}</strong>
            </article>
            <article>
              <span>Falhas</span>
              <strong>{overview.usage.failed}</strong>
            </article>
            <article>
              <span>Latência média</span>
              <strong>
                {overview.usage.avg_latency_ms === null
                  ? "—"
                  : `${overview.usage.avg_latency_ms} ms`}
              </strong>
            </article>
            <article>
              <span>Artifacts</span>
              <strong>{formatBytes(overview.usage.artifact_bytes)}</strong>
            </article>
          </section>

          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Devices</p>
                <h2>Máquinas autorizadas</h2>
              </div>
              <span>{overview.devices.length} registradas</span>
            </div>
            <div className="grid">
              {overview.devices.length ? (
                overview.devices.map((device) => (
                  <DeviceCard
                    key={device.device_id}
                    device={device}
                    busy={busyId === device.device_id}
                    onRevoke={handleRevoke}
                  />
                ))
              ) : (
                <p className="empty-state">Nenhum device ativo.</p>
              )}
            </div>
          </section>

          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Approvals</p>
                <h2>Caixa de aprovação</h2>
              </div>
              <span>{pendingApprovals.length} pendentes</span>
            </div>
            <div className="grid">
              {overview.approvals.length ? (
                overview.approvals.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    busy={busyId === approval.id}
                    onDecision={handleDecision}
                  />
                ))
              ) : (
                <p className="empty-state">Nenhum approval registrado.</p>
              )}
            </div>
          </section>

          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Timeline</p>
                <h2>Commands e processos</h2>
              </div>
              <span>{overview.sessions.length} sessões recentes</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Operação</th>
                    <th>Device</th>
                    <th>Workspace</th>
                    <th>Estado</th>
                    <th>Risco</th>
                    <th>Solicitado</th>
                    <th>Erro</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.commands.length ? (
                    overview.commands.map((command) => (
                      <CommandRowView key={command.id} command={command} />
                    ))
                  ) : (
                    <tr>
                      <td colSpan={7}>Nenhum command registrado.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Audit</p>
                <h2>Eventos recentes</h2>
              </div>
              <span>{overview.audit.length} eventos</span>
            </div>
            <ol className="timeline">
              {overview.audit.length ? (
                overview.audit.map((event) => (
                  <li key={event.id}>
                    <div>
                      <strong>{event.event_type}</strong>
                      <span>
                        {event.decision ?? "—"} · {event.risk ?? "—"}
                      </span>
                    </div>
                    <time dateTime={event.created_at}>
                      {formatDate(event.created_at)}
                    </time>
                  </li>
                ))
              ) : (
                <li>Nenhum evento de audit.</li>
              )}
            </ol>
          </section>
        </main>
      ) : null}
    </div>
  );
}
