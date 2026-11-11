import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { getTelegramInitData, initializeTelegramWebApp } from "./telegram";
import { apiUrl, appBaseUrl } from "./api";

type Tournament = {
  id: number;
  name: string;
  status: string;
  start_date: string;
  end_date: string;
  period: "past" | "ongoing" | "upcoming";
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

type AdminPlayer = {
  id: number;
  team_id: number;
  telegram_user_id: number | null;
  invited_username: string;
  username: string;
  status: "invited" | "active";
  is_captain: number;
  team_name: string;
  team_tag: string;
};

type PlayerSanction = {
  telegram_user_id: number;
  username: string;
  reason: string;
  created_at: string;
  expires_at: string | null;
  lifted_at: string | null;
  active: boolean;
};

type AdminOverview = {
  tournament: Tournament | null;
  tournaments: Tournament[];
  teams: Team[];
  matches: Match[];
  players: AdminPlayer[];
  bans: PlayerSanction[];
};
type Payload = Record<string, unknown>;

export default function AdminApp() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [selectedTournamentId, setSelectedTournamentId] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  function authHeaders(): Record<string, string> {
    const initData = getTelegramInitData();
    if (!initData) throw new Error("Відкрий адмін-панель через PROFCOM LNMU у Telegram WebApp.");
    return { "X-Telegram-Init-Data": initData };
  }

  async function loadOverview(tournamentId: number | null = selectedTournamentId): Promise<AdminOverview> {
    const query = tournamentId === null ? "" : `?tournament_id=${tournamentId}`;
    const response = await fetch(apiUrl(`/api/admin/overview${query}`), { headers: authHeaders() });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Не вдалося завантажити адмін-дані.");
    setOverview(result as AdminOverview);
    setSelectedTournamentId((result as AdminOverview).tournament?.id ?? null);
    return result as AdminOverview;
  }

  async function request(path: string, payload: Payload = {}): Promise<Record<string, unknown>> {
    const response = await fetch(apiUrl(`/api/admin/${path}`), {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Не вдалося виконати дію.");
    return result as Record<string, unknown>;
  }

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const actionResult = await action();
      const tournamentsResponse = await fetch(apiUrl("/api/admin/tournaments"), { headers: authHeaders() });
      const tournamentList = await tournamentsResponse.json();
      if (!tournamentsResponse.ok) throw new Error(tournamentList.error ?? "Не вдалося оновити список турнірів.");
      const availableTournaments = tournamentList.tournaments as Tournament[];
      const requestedId = typeof actionResult === "number" || actionResult === null
        ? actionResult
        : selectedTournamentId;
      const nextId = requestedId !== null && availableTournaments.some((item) => item.id === requestedId)
        ? requestedId
        : availableTournaments[0]?.id ?? null;
      setSelectedTournamentId(nextId);
      await loadOverview(nextId);
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
      setError("Відкрий адмін-панель через PROFCOM LNMU у Telegram WebApp.");
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
        const tournamentsResponse = await fetch(apiUrl("/api/admin/tournaments"), { headers: authHeaders() });
        const tournamentList = await tournamentsResponse.json();
        if (!tournamentsResponse.ok) throw new Error(tournamentList.error ?? "Не вдалося завантажити турніри.");
        const availableTournaments = tournamentList.tournaments as Tournament[];
        const initialTournamentId = availableTournaments[0]?.id ?? null;
        setSelectedTournamentId(initialTournamentId);
        await loadOverview(initialTournamentId);
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
  const activeSanctions = new Map(
    (overview?.bans ?? [])
      .filter((sanction) => sanction.active)
      .map((sanction) => [sanction.telegram_user_id, sanction]),
  );

  return (
    <div className="app-shell admin-shell">
      <header className="app-header">
        <a className="brand" href={appBaseUrl} aria-label="Повернутися на сайт">
          <span className="brand-icon"><i className="bi bi-shield-lock" /></span>
          <span>PROFCOM <b>LNMU</b></span>
        </a>
        <a className="game-label admin-back-link" href={appBaseUrl}>Публічний сайт <i className="bi bi-box-arrow-up-right" /></a>
      </header>
      <main className="app-content">
        <PageTitle eyebrow="PROFCOM LNMU · КЕРУВАННЯ" title="Адмін-панель" />
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
            <section className="admin-card admin-tournament-selector">
              <label>ОБРАТИ ТУРНІР ДЛЯ КЕРУВАННЯ
                <select
                  value={selectedTournamentId ?? ""}
                  disabled={busy || !overview.tournaments.length}
                  onChange={(event) => {
                    const tournamentId = Number(event.currentTarget.value);
                    setBusy(true);
                    setError("");
                    void loadOverview(tournamentId)
                      .catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : "Не вдалося завантажити турнір."))
                      .finally(() => setBusy(false));
                  }}
                >
                  {!overview.tournaments.length && <option value="">Турнірів ще немає</option>}
                  {overview.tournaments.map((tournament) => (
                    <option key={tournament.id} value={tournament.id}>
                      {tournament.name} · {adminPeriodLabel(tournament.period)}
                    </option>
                  ))}
                </select>
              </label>
              {overview.tournament && (
                <button
                  type="button"
                  className="delete-tournament-button"
                  disabled={busy}
                  onClick={() => {
                    const confirmed = window.confirm(
                      `Видалити турнір «${overview.tournament?.name}» назавжди? Команди, заявки, матчі та результати буде видалено. Глобальні блокування гравців збережуться.`,
                    );
                    if (confirmed && overview.tournament) {
                      void run(
                        async () => {
                          await request(`tournaments/${overview.tournament?.id}/delete`);
                          return null;
                        },
                        "Турнір і його дані видалено.",
                      );
                    }
                  }}
                >
                  <i className="bi bi-trash3" /> Видалити турнір
                </button>
              )}
            </section>
            <section className="content-section">
              <SectionHeading title={`Гравці та блокування (${overview.players.length})`} />
              <p className="admin-help">Telegram ID бачать лише адміністратори. Запрошені гравці з'являться тут після підтвердження у WebApp.</p>
              <div className="admin-list">
                {overview.players.map((player) => {
                  const sanction = player.telegram_user_id ? activeSanctions.get(player.telegram_user_id) : undefined;
                  return (
                    <AdminPlayerRow
                      key={player.id}
                      player={player}
                      sanction={sanction}
                      busy={busy}
                      onBan={(payload) => run(
                        () => request(`players/${player.telegram_user_id}/ban`, payload),
                        `Обмеження для @${player.username || player.invited_username} застосовано.`,
                      )}
                      onUnban={() => run(
                        () => request(`players/${player.telegram_user_id}/unban`),
                        `Обмеження для @${player.username || player.invited_username} знято.`,
                      )}
                    />
                  );
                })}
                {!overview.players.length && <EmptyState text="Підтверджених гравців у складах поки немає." />}
              </div>
              {overview.bans.some((sanction) => !sanction.active) && (
                <p className="admin-help">Завершені або зняті обмеження залишаються в історії для адміністраторів.</p>
              )}
            </section>
            <AdminForm title="Створити турнір" busy={busy} submitLabel="СТВОРИТИ ТУРНІР" onSubmit={(payload) => run(
              async () => {
                const result = await request("tournaments", payload);
                const created = result.tournament as { id?: unknown } | undefined;
                if (typeof created?.id !== "number") throw new Error("Сервер не повернув ID створеного турніру.");
                return created.id;
              },
              "Турнір створено.",
            )}>
              <label>НАЗВА ТУРНІРУ<input name="name" required maxLength={100} placeholder="Назва турніру" /></label>
              <label>URL ЛОГОТИПА (НЕОБОВ'ЯЗКОВО)<input name="logo_url" type="url" maxLength={2048} placeholder="https://…" /></label>
              <LogoFilePicker />
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
                          <button className="approve-button" disabled={busy} onClick={() => void run(async () => { await request(`tournaments/${overview.tournament?.id}/teams/${team.id}/approve`); }, `Команду ${team.tag} підтверджено.`)} aria-label={`Підтвердити ${team.tag}`}><i className="bi bi-check-lg" /></button>
                          <button className="reject-button" disabled={busy} onClick={() => void run(async () => { await request(`tournaments/${overview.tournament?.id}/teams/${team.id}/reject`); }, `Заявку ${team.tag} відхилено.`)} aria-label={`Відхилити ${team.tag}`}><i className="bi bi-x-lg" /></button>
                        </div>
                      </div>
                    ))}
                    {!pendingTeams.length && <EmptyState text="Нових заявок немає." />}
                  </div>
                </section>
                <AdminForm title="Додати матч" busy={busy} submitLabel="ДОДАТИ МАТЧ" onSubmit={(payload) => run(
                  async () => { await request(`tournaments/${overview.tournament?.id}/matches`, payload); },
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
                        async () => { await request(`tournaments/${overview.tournament?.id}/matches/${match.id}/result`, payload); },
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
  const [formError, setFormError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setFormError("");
    try {
      const payload = Object.fromEntries(new FormData(form).entries());
      const fileInput = form.querySelector<HTMLInputElement>('input[name="logo_file"]');
      const image = fileInput?.files?.[0];
      delete payload.logo_file;
      if (image) payload.logo_url = await optimizeLogo(image);
      if (await onSubmit(payload)) form.reset();
    } catch (submitError) {
      setFormError(submitError instanceof Error ? submitError.message : "Не вдалося підготувати логотип.");
    }
  }
  return <section className="admin-card"><h2>{title}</h2><form className="admin-form" onSubmit={submit}>{children}{formError && <div className="form-error" role="alert">{formError}</div>}<button className="primary-button full-width" disabled={busy}>{submitLabel} <i className="bi bi-arrow-right" /></button></form></section>;
}

function LogoFilePicker() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [fileName, setFileName] = useState("");

  useEffect(() => {
    const form = inputRef.current?.form;
    function resetPicker() {
      setPreviewUrl("");
      setFileName("");
    }
    form?.addEventListener("reset", resetPicker);
    return () => form?.removeEventListener("reset", resetPicker);
  }, []);

  useEffect(() => {
    if (!previewUrl) return;
    return () => URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  return (
    <label className="logo-file-picker">
      <span>АБО ДОДАЙ ЗОБРАЖЕННЯ З ГАЛЕРЕЇ</span>
      <input
        ref={inputRef}
        name="logo_file"
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          setPreviewUrl(file ? URL.createObjectURL(file) : "");
          setFileName(file?.name ?? "");
        }}
      />
      {previewUrl && <img className="logo-file-preview" src={previewUrl} alt="Попередній перегляд логотипа" />}
      <small>{fileName || "PNG, JPEG або WebP. Вибраний файл замінить URL і буде стиснутий автоматично."}</small>
    </label>
  );
}

async function optimizeLogo(file: File): Promise<string> {
  const supportedTypes = ["image/png", "image/jpeg", "image/webp"];
  if (!supportedTypes.includes(file.type)) throw new Error("Обери зображення PNG, JPEG або WebP.");
  if (file.size > 10 * 1024 * 1024) throw new Error("Початкове зображення має бути менше 10 МБ.");

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Не вдалося відкрити це зображення. Спробуй інший файл.");
  }

  try {
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    let width = Math.max(1, Math.round(bitmap.width * scale));
    let height = Math.max(1, Math.round(bitmap.height * scale));
    let quality = 0.84;

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Не вдалося підготувати зображення.");
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
      if (!blob) throw new Error("Не вдалося стиснути зображення.");
      if (blob.size <= 512 * 1024) {
        return await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Не вдалося прочитати логотип."));
          reader.onerror = () => reject(new Error("Не вдалося прочитати логотип."));
          reader.readAsDataURL(blob);
        });
      }
      width = Math.max(128, Math.round(width * 0.8));
      height = Math.max(128, Math.round(height * 0.8));
      quality = Math.max(0.45, quality - 0.08);
    }
  } finally {
    bitmap.close();
  }
  throw new Error("Не вдалося зменшити логотип до 512 КБ. Спробуй інше зображення.");
}

function AdminPlayerRow({
  player,
  sanction,
  busy,
  onBan,
  onUnban,
}: {
  player: AdminPlayer;
  sanction?: PlayerSanction;
  busy: boolean;
  onBan: (payload: Payload) => Promise<boolean>;
  onUnban: () => Promise<boolean>;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await onBan(Object.fromEntries(new FormData(form).entries()))) form.reset();
  }

  return (
    <div className="admin-player-row">
      <div className="admin-player-identity">
        <strong>{player.username || player.invited_username ? `@${player.username || player.invited_username}` : "Гравець без username"} {player.is_captain ? "· капітан" : ""}</strong>
        <small>{player.team_tag} · {player.team_name}</small>
        {player.telegram_user_id ? (
          <code>Telegram ID: {player.telegram_user_id}</code>
        ) : (
          <small>Запрошення очікує підтвердження</small>
        )}
      </div>
      {player.telegram_user_id && (
        sanction ? (
          <div className="admin-sanction">
            <small>{sanction.expires_at ? `До ${new Intl.DateTimeFormat("uk-UA", { dateStyle: "short", timeStyle: "short" }).format(new Date(sanction.expires_at))}` : "Постійне обмеження"} · {sanction.reason}</small>
            <button type="button" className="approve-button" disabled={busy} onClick={() => void onUnban()} aria-label={`Зняти обмеження з ${player.username}`}><i className="bi bi-unlock" /></button>
          </div>
        ) : (
          <form className="admin-sanction-form" onSubmit={(event) => void submit(event)}>
            <input name="reason" required maxLength={300} placeholder="Причина обмеження" aria-label="Причина обмеження" />
            <select name="duration" defaultValue="permanent" aria-label="Тривалість обмеження">
              <option value="permanent">Постійно</option>
              <option value="1d">1 день</option>
              <option value="7d">7 днів</option>
              <option value="30d">30 днів</option>
            </select>
            <button type="submit" className="reject-button" disabled={busy} aria-label={`Застосувати обмеження до ${player.username}`}><i className="bi bi-slash-circle" /></button>
          </form>
        )
      )}
    </div>
  );
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

function adminPeriodLabel(period: Tournament["period"]) {
  if (period === "past") return "минулий";
  if (period === "upcoming") return "майбутній";
  return "триває";
}
