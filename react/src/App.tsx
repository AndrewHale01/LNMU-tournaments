import { useEffect, useState, type FormEvent } from "react";
import { getTelegramInitData, getTelegramUser, initializeTelegramWebApp, type TelegramUser } from "./telegram";
import { apiUrl, appBaseUrl } from "./api";

type Tournament = {
  id: number;
  name: string;
  logo_url: string;
  start_date: string;
  end_date: string;
  prize_pool: number;
  team_limit: number;
  format: "groups" | "playoff" | "both";
  win_points: number;
  status: string;
  registered_teams: number;
  pending_teams: number;
};

type Team = {
  id: number;
  tournament_id: number;
  name: string;
  tag: string;
  captain: string;
  contact?: string;
  status: "pending" | "approved" | "rejected";
  created_at: string;
};

type Match = {
  id: number;
  date: string;
  time: string;
  phase: "groups" | "playoff";
  stage: string;
  map: string;
  team_a_id: number | null;
  team_b_id: number | null;
  team_a: string | null;
  team_b: string | null;
  score_a: number | null;
  score_b: number | null;
  status: "upcoming" | "finished";
};

type Standing = {
  id: number;
  name: string;
  tag: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
};

type Overview = {
  tournament: Tournament | null;
  matches: Match[];
  teams: Team[];
  leaderboard: { place: number; tag: string; name: string; points: number; trend: "same" }[];
  standings: Standing[];
  bracket: Match[];
};

type Tab = "home" | "tournament" | "matches" | "rules" | "profile";

const navigation: { id: Tab; label: string; icon: string }[] = [
  { id: "home", label: "Головна", icon: "bi-house-door" },
  { id: "tournament", label: "Турнір", icon: "bi-trophy" },
  { id: "matches", label: "Матчі", icon: "bi-controller" },
  { id: "rules", label: "Правила", icon: "bi-journal-text" },
  { id: "profile", label: "Профіль", icon: "bi-person" },
];

const money = new Intl.NumberFormat("uk-UA");

function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeTab, setActiveTab] = useState<Tab>("home");
  const [modalOpen, setModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [success, setSuccess] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  async function refreshOverview() {
    const response = await fetch(apiUrl("/api/overview"));
    if (!response.ok) throw new Error("Не вдалося завантажити дані турніру.");
    setOverview((await response.json()) as Overview);
  }

  useEffect(() => {
    initializeTelegramWebApp();
    refreshOverview().catch((error: Error) => setLoadError(error.message));
    const initData = getTelegramInitData();
    if (initData) {
      fetch(apiUrl("/api/admin/session"), { headers: { "X-Telegram-Init-Data": initData } })
        .then((response) => { if (response.ok) setIsAdmin(true); })
        .catch(() => setIsAdmin(false));
    }
  }, []);

  async function registerTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setSubmitting(true);
    setFormError("");
    setSuccess("");

    try {
      const response = await fetch(apiUrl("/api/teams"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Не вдалося зареєструвати команду.");
      setSuccess(`Заявку команди ${result.team.tag} надіслано адміну на підтвердження.`);
      form.reset();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Сталася помилка реєстрації.");
    } finally {
      setSubmitting(false);
    }
  }

  const tournament = overview?.tournament ?? null;
  const placesTaken = tournament ? tournament.registered_teams + tournament.pending_teams : 0;
  const slotsLeft = tournament ? Math.max(tournament.team_limit - placesTaken, 0) : 0;

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="brand" onClick={() => setActiveTab("home")} aria-label="На головну">
          <span className="brand-icon"><i className="bi bi-crosshair2" /></span>
          <span>PROFCOM <b>LNMU</b></span>
        </button>
        <span className="game-label">{tournament ? "CS2 · " + tournament.name : "CS2 · ТУРНІРИ"}</span>
      </header>

      <main className="app-content">
        {loadError && <div className="error-banner" role="alert">{loadError} Перевір, чи запущений Python-бекенд.</div>}
        {!overview && !loadError && <div className="loading-state"><span className="spinner" />Завантаження турніру…</div>}
        {overview && activeTab === "home" && (
          <HomePage
            overview={overview}
            slotsLeft={slotsLeft}
            onNavigate={setActiveTab}
            onRegister={() => { setSuccess(""); setFormError(""); setModalOpen(true); }}
          />
        )}
        {overview && activeTab === "tournament" && <TournamentPage overview={overview} slotsLeft={slotsLeft} onRegister={() => { setSuccess(""); setFormError(""); setModalOpen(true); }} />}
        {overview && activeTab === "matches" && <MatchesPage matches={overview.matches} />}
        {overview && activeTab === "rules" && <RulesPage />}
        {overview && activeTab === "profile" && <ProfilePage isAdmin={isAdmin} user={getTelegramUser()} />}
      </main>

      <nav className="bottom-nav" aria-label="Основна навігація">
        {navigation.map((item) => (
          <button
            className={`nav-item ${activeTab === item.id ? "active" : ""}`}
            key={item.id}
            onClick={() => setActiveTab(item.id)}
            aria-current={activeTab === item.id ? "page" : undefined}
          >
            <i className={`bi ${item.icon}`} aria-hidden="true" />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      {modalOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setModalOpen(false)}>
          <section className="registration-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <div className="modal-heading">
              <div><span className="eyebrow">{tournament?.name ?? "PROFCOM LNMU"} · CS2</span><h2 id="modal-title">Реєстрація команди</h2></div>
              <button className="close-button" onClick={() => setModalOpen(false)} aria-label="Закрити"><i className="bi bi-x-lg" /></button>
            </div>
            {success ? (
              <div className="success-panel">
                <i className="bi bi-check-circle-fill" />
                <strong>Заявку надіслано</strong>
                <p>{success}</p>
                <button className="primary-button full-width" onClick={() => setModalOpen(false)}>Готово</button>
              </div>
            ) : (
              <form className="registration-form" onSubmit={registerTeam}>
                <label>НАЗВА КОМАНДИ<input name="name" required maxLength={60} placeholder="Наприклад, Kyiv Five" /></label>
                <label>ТЕГ КОМАНДИ<input name="tag" required maxLength={8} placeholder="KYIV" /></label>
                <label>STEAM НІК КАПІТАНА<input name="captain" required maxLength={60} placeholder="Твій ігровий нік" /></label>
                <label>TELEGRAM ДЛЯ ЗВ'ЯЗКУ<input name="contact" required maxLength={80} placeholder="@username" /></label>
                {formError && <div className="form-error" role="alert">{formError}</div>}
                <button className="primary-button full-width" disabled={submitting || !tournament || slotsLeft === 0}>
                  {submitting ? "НАДСИЛАЄМО…" : !tournament ? "НЕМАЄ АКТИВНОГО ТУРНІРУ" : slotsLeft === 0 ? "ВІЛЬНИХ МІСЦЬ НЕМАЄ" : "НАДІСЛАТИ ЗАЯВКУ"} <i className="bi bi-arrow-right" />
                </button>
              </form>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function HomePage({
  overview,
  slotsLeft,
  onNavigate,
  onRegister,
}: {
  overview: Overview;
  slotsLeft: number;
  onNavigate: (tab: Tab) => void;
  onRegister: () => void;
}) {
  const { tournament, matches, leaderboard } = overview;
  const nextMatch = matches.find((match) => match.status === "upcoming");

  return (
    <>
      <section className="welcome">
        <span className="eyebrow">УКРАЇНСЬКА CS2-СПІЛЬНОТА ЛНМУ</span>
        <h1>Час грати.</h1>
        <p>Турніри, команди та матчі — все в одному місці для медиків.</p>
      </section>
      {tournament ? (
        <TournamentSummary tournament={tournament} slotsLeft={slotsLeft} onRegister={onRegister} />
      ) : (
        <EmptyState text="Турнір ще не створено. Завітай пізніше." />
      )}
      <section className="content-section">
        <SectionHeading title="Наступний матч" action="Усі матчі" onAction={() => onNavigate("matches")} />
        {nextMatch ? <MatchCard match={nextMatch} /> : <EmptyState text="Матчі з'являться після підтвердження команд і створення розкладу адміністратором." />}
      </section>
      <section className="content-section">
        <SectionHeading title="Топ команд" />
        {leaderboard.length ? (
          <div className="team-list compact-list">{leaderboard.slice(0, 3).map((team) => <TeamRow key={team.tag} team={team} />)}</div>
        ) : (
          <EmptyState text="Тут з'являться підтверджені команди. Очки нараховуються за перемоги в матчах." />
        )}
      </section>
    </>
  );
}

function TournamentSummary({ tournament, slotsLeft, onRegister }: { tournament: Tournament; slotsLeft: number; onRegister: () => void }) {
  return (
    <section className="tournament-card">
      <div className="card-topline">
        <span className={`status-pill ${tournament.status !== "registration" ? "status-neutral" : ""}`}><i /> {tournament.status === "registration" ? "Реєстрація відкрита" : "Турнір триває"}</span>
        {tournament.logo_url && <img className="tournament-logo" src={tournament.logo_url} alt={`Логотип ${tournament.name}`} />}
      </div>
      <div className="card-game">COUNTER-STRIKE 2</div>
      <h2>{tournament.name}</h2>
      <div className="tournament-facts">
        <div><span>ПРИЗОВИЙ ФОНД</span><strong>{money.format(tournament.prize_pool)} ₴</strong></div>
        <div><span>ВІЛЬНІ СЛОТИ</span><strong>{slotsLeft} <small>/ {tournament.team_limit}</small></strong></div>
      </div>
      <button className="primary-button full-width" onClick={onRegister} disabled={tournament.status !== "registration" || slotsLeft === 0}>
        {tournament.status !== "registration" ? "РЕЄСТРАЦІЯ ЗАКРИТА" : slotsLeft === 0 ? "ВІЛЬНИХ МІСЦЬ НЕМАЄ" : "Зареєструвати команду"} <i className="bi bi-arrow-right" />
      </button>
    </section>
  );
}

function TournamentPage({ overview, slotsLeft, onRegister }: { overview: Overview; slotsLeft: number; onRegister: () => void }) {
  const { tournament } = overview;
  return (
    <>
      <PageTitle eyebrow="PROFCOM LNMU · CS2" title="Турнір" />
      {!tournament ? <EmptyState text="Турнір ще не створено. Адміністратор додасть його тут." /> : (
        <>
          <TournamentSummary tournament={tournament} slotsLeft={slotsLeft} onRegister={onRegister} />
          <section className="content-section">
            <SectionHeading title="Деталі турніру" />
            <div className="details-card">
              <DetailRow icon="bi-calendar3" label="ДАТИ" value={`${formatDate(tournament.start_date)} — ${formatDate(tournament.end_date)}`} />
              <DetailRow icon="bi-controller" label="ФОРМАТ МАТЧУ" value="CS2 · 5 на 5" />
              <DetailRow icon="bi-trophy" label="ФОРМАТ ТУРНІРУ" value={formatLabel(tournament.format)} />
              <DetailRow icon="bi-people" label="ПІДТВЕРДЖЕНО" value={`${tournament.registered_teams} / ${tournament.team_limit} команд`} />
            </div>
          </section>
          {tournament.format !== "playoff" && (
            <section className="content-section">
              <SectionHeading title="Таблиця груп" />
              <StandingsTable standings={overview.standings} />
            </section>
          )}
          {tournament.format !== "groups" && (
            <section className="content-section">
              <SectionHeading title="Сітка плей-оф" />
              <Bracket matches={overview.bracket} />
            </section>
          )}
          <section className="content-section">
            <SectionHeading title="Розклад матчів" />
            {overview.matches.length ? overview.matches.map((match) => <MatchCard key={match.id} match={match} />) : <EmptyState text="Адміністратор ще не додав матчі." />}
          </section>
        </>
      )}
    </>
  );
}

function MatchesPage({ matches }: { matches: Match[] }) {
  return (
    <>
      <PageTitle eyebrow="CS2 · РОЗКЛАД" title="Матчі" />
      <div className="filter-label"><i className="bi bi-calendar3" /> Розклад турніру</div>
      <div className="match-list">
        {matches.map((match) => <MatchCard key={match.id} match={match} />)}
        {!matches.length && <EmptyState text="Розклад поки порожній. Матчі додасть адміністратор." />}
      </div>
    </>
  );
}

function MatchCard({ match }: { match: Match }) {
  return (
    <article className="match-card">
      <div className="match-card-meta">
        <span>{formatDate(match.date)} · {match.time}</span>
        <span className={match.status === "upcoming" ? "match-stage" : "live-label"}>{match.stage}</span>
      </div>
      <div className="match-card-teams">
        <span className="match-team">{match.team_a ?? "TBA"}</span>
        <strong>{match.score_a === null ? "— : —" : `${match.score_a} : ${match.score_b}`}</strong>
        <span className="match-team align-right">{match.team_b ?? "TBA"}</span>
      </div>
      {match.map && <div className="match-map"><i className="bi bi-geo-alt" /> {match.map}</div>}
    </article>
  );
}

function RulesPage() {
  return (
    <>
      <PageTitle eyebrow="PROFCOM LNMU · CS2" title="Правила" />
      <section className="content-section first-section">
        <p className="rules-intro">Основні умови участі в турнірах PROFCOM LNMU.</p>
        <div className="rules-list">
          <RuleCard number="01" icon="bi-person-plus" title="Реєстрація та допуск">
            Надішли заявку з даними команди. Участь у турнірі підтверджується адміністратором.
          </RuleCard>
          <RuleCard number="02" icon="bi-calendar-event" title="Формат і розклад">
            Формат турніру, матчі та розклад публікуються на сторінці турніру. Перевіряй їх перед грою.
          </RuleCard>
          <RuleCard number="03" icon="bi-shield-check" title="Чесна гра">
            Грай чесно та поважай суперників. Використання читів і навмисне порушення правил не допускаються.
          </RuleCard>
          <RuleCard number="04" icon="bi-trophy" title="Результати та рейтинг">
            Результати матчів вносить адміністратор. Очки команд і таблиця оновлюються за результатами перемог.
          </RuleCard>
        </div>
        <p className="rules-note">Додаткові умови конкретного турніру повідомляє його адміністратор.</p>
      </section>
    </>
  );
}

function RuleCard({ number, icon, title, children }: { number: string; icon: string; title: string; children: string }) {
  return (
    <article className="rule-card">
      <span className="rule-icon"><i className={`bi ${icon}`} aria-hidden="true" /></span>
      <div className="rule-copy">
        <div className="rule-heading"><h2>{title}</h2><span>{number}</span></div>
        <p>{children}</p>
      </div>
    </article>
  );
}

function TeamRow({ team }: { team: Overview["leaderboard"][number] }) {
  return (
    <div className="team-row">
      <span className="team-place">{String(team.place).padStart(2, "0")}</span>
      <span className="team-avatar">{team.tag.slice(0, 1)}</span>
      <span className="team-info"><strong>{team.name}</strong><small>{team.tag}</small></span>
      <span className="team-points">{team.points} <small>pts</small></span>
    </div>
  );
}

function StandingsTable({ standings }: { standings: Standing[] }) {
  if (!standings.length) return <EmptyState text="Таблиця заповниться після підтвердження команд." />;
  return (
    <div className="standings-wrap">
      <table className="standings-table">
        <thead><tr><th>#</th><th>Команда</th><th>І</th><th>В</th><th>Н</th><th>П</th><th>О</th></tr></thead>
        <tbody>{standings.map((team, index) => (
          <tr key={team.id}>
            <td>{index + 1}</td><td className="standing-team">{team.tag}</td><td>{team.played}</td><td>{team.wins}</td><td>{team.draws}</td><td>{team.losses}</td><td><strong>{team.points}</strong></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Bracket({ matches }: { matches: Match[] }) {
  if (!matches.length) return <EmptyState text="Сітка плей-оф з'явиться, коли адміністратор додасть матчі плей-оф." />;
  const rounds = new Map<string, Match[]>();
  for (const match of matches) {
    const round = rounds.get(match.stage) ?? [];
    round.push(match);
    rounds.set(match.stage, round);
  }
  return (
    <div className="bracket-list">
      {[...rounds].map(([stage, stageMatches]) => (
        <section className="bracket-round" key={stage}>
          <h3>{stage}</h3>
          {stageMatches.map((match) => (
            <div className="bracket-match" key={match.id}>
              <div><strong>{match.team_a ?? "TBA"}</strong><b>{match.score_a ?? "—"}</b></div>
              <div><strong>{match.team_b ?? "TBA"}</strong><b>{match.score_b ?? "—"}</b></div>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function ProfilePage({ isAdmin, user }: { isAdmin: boolean; user: TelegramUser | null }) {
  const fullName = user ? [user.first_name, user.last_name].filter(Boolean).join(" ") : "";

  return (
    <>
      <PageTitle eyebrow="PROFCOM LNMU · CS2" title="Профіль" />
      <section className="profile-card">
        <div className="profile-identity">
          <span className={`profile-avatar ${user?.photo_url ? "has-photo" : ""}`}>
            {user?.photo_url ? <img src={user.photo_url} alt="" /> : <i className="bi bi-person" />}
          </span>
          <div className="profile-name">
            <h2>{user ? fullName : "Профіль гравця"}</h2>
            <span className={`profile-status ${user ? "connected" : ""}`}>
              <i /> {user ? "Telegram підключено" : "Telegram не підключено"}
            </span>
          </div>
        </div>
        {user ? (
          <div className="profile-details">
            {user.username && <DetailRow icon="bi-at" label="TELEGRAM" value={`@${user.username}`} />}
            <DetailRow icon="bi-controller" label="СПІЛЬНОТА" value="PROFCOM LNMU · CS2" />
          </div>
        ) : (
          <p className="profile-note">Відкрий цей застосунок через Telegram, щоб побачити дані свого профілю.</p>
        )}
        {isAdmin && <a className="primary-button full-width profile-admin-link" href={`${appBaseUrl}admin.html`}><i className="bi bi-shield-lock" /> Адмін-панель</a>}
      </section>
    </>
  );
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <div className="detail-row"><span className="detail-icon"><i className={`bi ${icon}`} /></span><span className="detail-label">{label}</span><strong>{value}</strong></div>;
}

function SectionHeading({ title, action, onAction }: { title: string; action?: string; onAction?: () => void }) {
  return <div className="section-heading"><h2>{title}</h2>{action && <button className="text-button" onClick={onAction}>{action} <i className="bi bi-chevron-right" /></button>}</div>;
}

function PageTitle({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <header className="page-title"><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></header>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="empty-state"><i className="bi bi-inbox" /><span>{text}</span></div>;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "short" })
    .format(new Date(`${value}T12:00:00`))
    .replace(".", "");
}

function formatLabel(value: Tournament["format"]) {
  if (value === "groups") return "Лише таблиця";
  if (value === "playoff") return "Лише плей-оф";
  return "Таблиця і плей-оф";
}

export default App;
