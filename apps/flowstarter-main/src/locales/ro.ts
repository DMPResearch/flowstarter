/** Romanian overrides — keys omitted here fall back to English (see i18n merge). */
const ro: Record<string, string> = {
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
