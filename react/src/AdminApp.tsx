import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { getTelegramInitData, initializeTelegramWebApp } from "./telegram";
import { apiUrl, appBaseUrl } from "./api";

type Tournament = {
  id: number;
  name: string;
  status: string;
};

type Team = {
  id: number;
  name: string;
  tag: string;
  captain: string;
  contact: string;
  status: "pending" | "approved" | "rejected";
};

type Match = {
  id: number;
  date: string;
  time: string;
  stage: string;
  team_a: string | null;
  team_b: string | null;
  score_a: number | null;
  score_b: number | null;
};

type AdminOverview = { tournament: Tournament | null; teams: Team[]; matches: Match[] };
type Payload = Record<string, unknown>;

export default function AdminApp() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function authHeaders(): Record<string, string> {
    const initData = getTelegramInitData();
    if (!initData) throw new Error("Відкрий адмін-панель через FRAG UA у Telegram WebApp.");
    return { "X-Telegram-Init-Data": initData };
  }

  async function loadOverview(): Promise<AdminOverview> {
    const response = await fetch(apiUrl("/api/admin/overview"), { headers: authHeaders() });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Не вдалося завантажити адмін-дані.");
    setOverview(result as AdminOverview);
    return result as AdminOverview;
  }

  async function request(path: string, payload: Payload = {}) {
    const response = await fetch(apiUrl(`/api/admin/${path}`), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Не вдалося виконати дію.");
  }

  async function run(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      await loadOverview();
      setNotice(message);
      return true;
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Сталася помилка.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    initializeTelegramWebApp();
    const initData = getTelegramInitData();
    if (!initData) {
      setError("Відкрий адмін-панель через FRAG UA у Telegram WebApp.");
      return;
    }

    let active = true;
    async function authenticate() {
      setBusy(true);
      setError("");
      try {
        const response = await fetch(apiUrl("/api/admin/session"), {
          headers: { "X-Telegram-Init-Data": initData },
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Не вдалося підтвердити права адміністратора.");
        await loadOverview();
        if (active) setNotice(`Ви увійшли як ${result.user.first_name || "адміністратор"}.`);
      } catch (authError) {
        if (active) setError(authError instanceof Error ? authError.message : "Не вдалося увійти.");
      } finally {
        if (active) setBusy(false);
      }
    }

    void authenticate();
    return () => { active = false; };
  }, []);

  const pendingTeams = overview?.teams.filter((team) => team.status === "pending") ?? [];
  const approvedTeams = overview?.teams.filter((team) => team.status === "approved") ?? [];

  return (
    <div className="app-shell admin-shell">
      <header className="app-header">
        <a className="brand" href={appBaseUrl} aria-label="Повернутися на сайт">
          <span className="brand-icon"><i className="bi bi-shield-lock" /></span>
          <span>FRAG <b>ADMIN</b></span>
        </a>
        <a className="game-label admin-back-link" href={appBaseUrl}>Публічний сайт <i className="bi bi-box-arrow-up-right" /></a>
      </header>
      <main className="app-content">
        <PageTitle eyebrow="FRAG UA · КЕРУВАННЯ" title="Адмін-панель" />
        {!overview ? (
          <section className="admin-card admin-login">
            {busy && <p>Перевіряємо Telegram-акаунт…</p>}
            {error && <div className="form-error" role="alert">{error}</div>}
          </section>
        ) : (
          <>
            <div className="admin-topline">
              <span>{overview.tournament?.name ?? "Турнір ще не створений"}</span>
              <a className="text-button" href={appBaseUrl}>Повернутися</a>
            </div>
            {error && <div className="form-error admin-notice" role="alert">{error}</div>}
            {notice && <div className="admin-success admin-notice" role="status">{notice}</div>}
            <AdminForm title="Створити турнір" busy={busy} submitLabel="СТВОРИТИ ТУРНІР" onSubmit={(payload) => run(
              () => request("tournaments", payload),
              "Турнір створено.",
            )}>
              <label>НАЗВА ТУРНІРУ<input name="name" required maxLength={100} placeholder="Назва турніру" /></label>
              <label>URL ЛОГОТИПА<input name="logo_url" type="url" maxLength={500} placeholder="https://…" /></label>
              <div className="admin-form-grid">
                <label>ПОЧАТОК<input name="start_date" type="date" required /></label>
                <label>ЗАВЕРШЕННЯ<input name="end_date" type="date" required /></label>
              </div>
              <div className="admin-form-grid">
                <label>ПРИЗОВИЙ ФОНД, ₴<input name="prize_pool" type="number" min="0" defaultValue="0" required /></label>
                <label>МАКС. КОМАНД<input name="team_limit" type="number" min="2" max="128" defaultValue="16" required /></label>
              </div>
              <div className="admin-form-grid">
                <label>БАЛИ ЗА ПЕРЕМОГУ<input name="win_points" type="number" min="1" defaultValue="3" required /></label>
                <label>ФОРМАТ ТУРНІРУ
                  <select name="format" defaultValue="both">
                    <option value="groups">Лише таблиця</option>
                    <option value="playoff">Лише плей-оф</option>
                    <option value="both">Таблиця і плей-оф</option>
                  </select>
                </label>
              </div>
            </AdminForm>
            {overview.tournament && (
              <>
                <section className="content-section">
                  <SectionHeading title={`Заявки (${pendingTeams.length})`} />
                  <div className="admin-list">
                    {pendingTeams.map((team) => (
                      <div className="admin-row" key={team.id}>
                        <div className="team-info"><strong>{team.name} <small>({team.tag})</small></strong><small>{team.captain} · {team.contact}</small></div>
                        <div className="admin-row-actions">
                          <button className="approve-button" disabled={busy} onClick={() => void run(() => request(`teams/${team.id}/approve`), `Команду ${team.tag} підтверджено.`)} aria-label={`Підтвердити ${team.tag}`}><i className="bi bi-check-lg" /></button>
                          <button className="reject-button" disabled={busy} onClick={() => void run(() => request(`teams/${team.id}/reject`), `Заявку ${team.tag} відхилено.`)} aria-label={`Відхилити ${team.tag}`}><i className="bi bi-x-lg" /></button>
                        </div>
                      </div>
                    ))}
                    {!pendingTeams.length && <EmptyState text="Нових заявок немає." />}
                  </div>
                </section>
                <AdminForm title="Додати матч" busy={busy} submitLabel="ДОДАТИ МАТЧ" onSubmit={(payload) => run(
                  () => request("matches", payload),
                  "Матч додано до розкладу.",
                )}>
                  <div className="admin-form-grid">
                    <label>ДАТА<input name="date" type="date" required /></label>
                    <label>ЧАС<input name="time" type="time" required /></label>
                  </div>
                  <div className="admin-form-grid">
                    <label>КОМАНДА 1<select name="team_a_id" required defaultValue=""><option value="" disabled>Обрати команду</option>{approvedTeams.map((team) => <option key={team.id} value={team.id}>{team.tag}</option>)}</select></label>
                    <label>КОМАНДА 2<select name="team_b_id" required defaultValue=""><option value="" disabled>Обрати команду</option>{approvedTeams.map((team) => <option key={team.id} value={team.id}>{team.tag}</option>)}</select></label>
                  </div>
                  <div className="admin-form-grid">
                    <label>ФОРМАТ МАТЧУ<select name="phase" defaultValue="groups"><option value="groups">Групова таблиця</option><option value="playoff">Плей-оф</option></select></label>
                    <label>ЕТАП<input name="stage" required maxLength={40} placeholder="Група A / Фінал" /></label>
                  </div>
                  <label>МАПА<input name="map" maxLength={40} placeholder="de_mirage" /></label>
                  {approvedTeams.length < 2 && <p className="field-note">Потрібно підтвердити щонайменше дві команди.</p>}
                  <button className="primary-button full-width" disabled={busy || approvedTeams.length < 2}>ДОДАТИ МАТЧ <i className="bi bi-plus-lg" /></button>
                </AdminForm>
                <section className="content-section">
                  <SectionHeading title="Результати матчів" />
                  <div className="admin-list">
                    {overview.matches.map((match) => (
                      <ResultForm key={match.id} match={match} busy={busy} onSubmit={(payload) => run(
                        () => request(`matches/${match.id}/result`, payload),
                        "Результат матчу збережено.",
                      )} />
                    ))}
                    {!overview.matches.length && <EmptyState text="Додай матч, щоб внести результат." />}
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

function AdminForm({ title, children, busy, submitLabel, onSubmit }: {
  title: string;
  children: ReactNode;
  busy: boolean;
  submitLabel: string;
  onSubmit: (payload: Payload) => Promise<boolean>;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await onSubmit(Object.fromEntries(new FormData(form).entries()))) form.reset();
  }
  return <section className="admin-card"><h2>{title}</h2><form className="admin-form" onSubmit={submit}>{children}<button className="primary-button full-width" disabled={busy}>{submitLabel} <i className="bi bi-arrow-right" /></button></form></section>;
}

function ResultForm({ match, busy, onSubmit }: { match: Match; busy: boolean; onSubmit: (payload: Payload) => Promise<boolean> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSubmit(Object.fromEntries(new FormData(event.currentTarget).entries()));
  }
  return (
    <form className="admin-result-row" onSubmit={submit}>
      <div className="admin-result-names"><strong>{match.team_a ?? "—"} <span>vs</span> {match.team_b ?? "—"}</strong><small>{match.date} · {match.stage}</small></div>
      <input aria-label={`Рахунок ${match.team_a}`} type="number" name="score_a" min="0" max="99" defaultValue={match.score_a ?? ""} required />
      <span>:</span>
      <input aria-label={`Рахунок ${match.team_b}`} type="number" name="score_b" min="0" max="99" defaultValue={match.score_b ?? ""} required />
      <button className="approve-button" disabled={busy} aria-label="Зберегти результат"><i className="bi bi-check-lg" /></button>
    </form>
  );
}

function PageTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <header className="page-title"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></header>;
}

function SectionHeading({ title }: { title: string }) {
  return <div className="section-heading"><h2>{title}</h2></div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state"><i className="bi bi-inbox" /><span>{text}</span></div>;
}
