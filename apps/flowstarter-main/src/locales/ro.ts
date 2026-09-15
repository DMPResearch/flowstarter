/** Romanian overrides — keys omitted here fall back to English (see i18n merge). */
const ro: Record<string, string> = {
  /**
   * The hold screen, when nothing could classify the brief.
   *
   * Translated rather than left to fall back to English, because this is
   * visitor-facing copy on the funnel's unhappy path and the funnel already
   * asks the visitor to pick a language. A Romanian visitor being told in
   * English that we are still checking reads as a second failure on top of
   * the first. Matches `holdNotice`'s `ro` strings in
   * `src/lib/policy/copy.ts`, which is the same message delivered by the
   * preview route rather than by the scope gate.
   */
  'landing.discovery.scope.hold.title': 'Încă verificăm',
  'landing.discovery.scope.hold.body':
    'Verificarea automată nu s-a finalizat pentru solicitarea dvs., așa că nu ghicim: am trimis-o unei persoane care o va citi. Nu s-a taxat nimic și nu s-a construit nimic încă.',
  'landing.discovery.scope.hold.next':
    'De obicei revenim în aceeași zi lucrătoare, la adresa de email pe care ne-ați dat-o.',

  'admin.dashboard.activity.eyebrow': 'Spațiu de lucru',
  'admin.dashboard.activity.title': 'Proiecte și conturi',
  'admin.dashboard.activity.tab.projects': 'Proiecte',
  'admin.dashboard.activity.tab.accounts': 'Conturi',

  'admin.hosting.connectExisting.button': 'Conectează un server existent',
  'admin.hosting.connectExisting.pending': 'Se conectează…',
  'admin.hosting.connectExisting.success': 'Serverul existent a fost conectat',
  'admin.hosting.connectExisting.error.generic':
    'Serverul existent nu a putut fi conectat',
  'admin.hosting.connectExisting.error.configMissing':
    'Serverul existent nu este configurat în acest mediu',
  'admin.hosting.connectExisting.error.secretUnavailable':
    'Datele de acces ale serverului existent nu sunt disponibile',
  'admin.hosting.connectExisting.error.healthCheckFailed':
    'Nu s-a putut verifica dacă serverul existent este pregătit',
  'admin.hosting.connectExisting.error.hetznerApiFailed':
    'Nu s-a putut verifica serverul la furnizorul de hosting',
  'admin.hosting.connectExisting.error.serverNotReady':
    'Serverul existent nu rulează încă',
  'admin.hosting.connectExisting.error.dbError':
    'Înregistrarea serverului nu a putut fi salvată',
};

export default ro;
