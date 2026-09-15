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

  // ─── The person block: asked only when the site is about one person ──────
  //
  // Matches the English block of the same keys in en.ts (search
  // `landing.discovery.chat.q.personStory` there for the surrounding
  // context). Written as natural Romanian, not a literal translation, in the
  // same warm, first-person, one-agent-to-one-person voice.
  'landing.discovery.chat.person.intro':
    'Urmează câteva întrebări despre tine, nu despre afacere. Toate sunt opționale, sari peste orice nu vrei să răspunzi, iar exact asta face ca site-ul tău să nu semene cu oricare altul.',
  'landing.discovery.chat.person.sourcing':
    'Tot ce citesc de pe paginile tale publice îți arăt mai întâi ție. Nimic nu ajunge pe site fără acordul tău.',
  'landing.discovery.chat.q.personStory.prompt':
    'Acum ceva despre tine, nu doar despre afacere: cine ești, într-o propoziție sau două? Asta devine pagina ta Despre, iar eu te citez așa cum ai spus-o, nu te rescriu.',
  'landing.discovery.chat.q.personStory.placeholder':
    'Am început reparând biciclete în garajul tatălui meu și încă azi mă bucur de o reparație bine făcută.',
  'landing.discovery.chat.q.personHowIWork.prompt':
    'Cum lucrezi și ce contează cu adevărat pentru tine? Spune-mi așa cum i-ai spune unui client nou.',
  'landing.discovery.chat.q.personHowIWork.placeholder':
    'Răspund singur la fiecare email, nu grăbesc niciodată o primă întâlnire și prefer să refuz decât să fac o treabă de mântuială.',
  'landing.discovery.chat.q.personFeel.prompt':
    'Când cineva ajunge pe site-ul tău, ce vrei să simtă?',
  'landing.discovery.chat.q.personFeel.placeholder':
    'Că tocmai a dat peste cineva care știe exact ce face.',
  'landing.discovery.chat.q.personProudest.prompt':
    'Care e lucrarea de care ești cel mai mândru și de ce anume?',
  'landing.discovery.chat.q.personProudest.placeholder':
    'O renovare de bucătărie pentru o familie care economisise ani de zile, pentru că am putut vedea cum o folosesc.',
  'landing.discovery.chat.q.personLinks.prompt':
    'Încă una, complet opțională: LinkedIn, Instagram, GitHub sau site-ul tău propriu. Dacă mi le dai, citesc paginile publice și îți propun o scurtă biografie și o fotografie, pe care le vezi și le aprobi tu înainte să fie publicat ceva, iar dacă preferi să sari peste asta, e absolut în regulă.',
  'landing.discovery.chat.q.personLinks.placeholder':
    'linkedin.com/in/tine, instagram.com/tine, siteultau.ro',
  'landing.discovery.chat.q.personToneWords.prompt':
    'Alege trei cuvinte care ar trebui să se regăsească în tot ce scriu despre tine, sau adaugă-le pe ale tale.',
  'landing.discovery.chat.q.personToneWords.placeholder':
    'Adaugă un cuvânt al tău…',
  'landing.discovery.chat.q.activityWhat.prompt':
    'Ce faci tu de fapt, cu cuvintele pe care le-ai folosi dacă te-ar întreba cineva la o petrecere?',
  'landing.discovery.chat.q.activityWhat.placeholder':
    'Construiesc mobilier pe comandă, mai ales mese și rafturi, din lemn recuperat.',
  'landing.discovery.chat.q.activityWho.prompt': 'Pentru cine faci asta?',
  'landing.discovery.chat.q.activityWho.placeholder':
    'Familii tinere care își renovează prima casă.',
  'landing.discovery.chat.q.activityTypical.prompt':
    'Cum arată, de obicei, un proiect, o colaborare sau o zi de lucru?',
  'landing.discovery.chat.q.activityTypical.placeholder':
    'Un prim apel ca să înțeleg ce ai nevoie, un plan într-o săptămână, apoi câteva săptămâni de lucru.',
  'landing.discovery.chat.q.activityKnownFor.prompt':
    'Ce îți cer oamenii cel mai des, sau pentru ce ești cunoscut?',
  'landing.discovery.chat.q.activityKnownFor.placeholder':
    'Că termin un proiect complet în mai puțin de o lună.',
  'landing.discovery.chat.q.activityYears.prompt': 'De cât timp faci asta?',
  'landing.discovery.chat.q.activityYears.placeholder': 'Cam opt ani.',

  'landing.discovery.chat.q.personStory.reflect':
    '"{quote}." Asta va spune pagina ta Despre, chiar cu cuvintele tale.',
  'landing.discovery.chat.q.personStory.reflect.skipped':
    'Nicio poveste deocamdată, nu-i nimic. Țin pagina Despre scurtă și las munca ta să vorbească de la sine.',
  'landing.discovery.chat.q.personHowIWork.reflect':
    '"{quote}." Asta e promisiunea pe care o face site-ul în numele tău.',
  'landing.discovery.chat.q.personHowIWork.reflect.skipped':
    'E în regulă, mă bazez pe ce mi-ai spus deja ca să transmit asta.',
  'landing.discovery.chat.q.personFeel.reflect':
    '{answer}. Fiecare rând de pe site va ținti spre acest sentiment.',
  'landing.discovery.chat.q.personFeel.reflect.skipped':
    'Merge și așa, țintesc spre cald și competent, dacă nu-mi spui altfel.',
  'landing.discovery.chat.q.personProudest.reflect':
    '"{quote}." Cu asta deschid povestea ta.',
  'landing.discovery.chat.q.personProudest.reflect.skipped':
    'Nicio grabă, aleg din ce mi-ai spus deja despre munca ta.',
  'landing.discovery.chat.q.personLinks.reflect':
    'Mulțumesc, le citesc și revin cu o scurtă biografie și o fotografie, ca să te uiți la ele. Nimic nu ajunge pe site înainte să spui tu da.',
  'landing.discovery.chat.q.personLinks.reflect.skipped':
    'Nicio problemă, îți scriu biografia din propriile tale cuvinte.',
  'landing.discovery.chat.q.personToneWords.reflect':
    '{list}: asta e vocea în care scriu partea ta din site.',
  'landing.discovery.chat.q.personToneWords.reflect.skipped':
    'N-ai ales cuvinte? Iau tonul din felul în care te-ai descris.',
  'landing.discovery.chat.q.activityWhat.reflect':
    '"{quote}." Așa va descrie site-ul ce faci.',
  'landing.discovery.chat.q.activityWhat.reflect.skipped':
    'Am înțeles, mă iau după ce mi-ai spus deja despre afacere.',
  'landing.discovery.chat.q.activityWho.reflect':
    'Deci lucrezi cu {answer}. Scriu fiecare pagină gândindu-mă la ei.',
  'landing.discovery.chat.q.activityWho.reflect.skipped':
    'Bine, scriu pentru publicul pe care mi l-ai descris deja.',
  'landing.discovery.chat.q.activityTypical.reflect':
    '"{quote}." Ăsta e procesul pe care îl pun pe site.',
  'landing.discovery.chat.q.activityTypical.reflect.skipped':
    'Nimic de adăugat, las procesul general deocamdată.',
  'landing.discovery.chat.q.activityKnownFor.reflect':
    '{answer}, notat. Cu asta deschid.',
  'landing.discovery.chat.q.activityKnownFor.reflect.skipped':
    'Rămâne nespus atunci, las munca să vorbească de la sine.',
  'landing.discovery.chat.q.activityYears.reflect':
    '{answer}. Menționez asta doar acolo unde îți câștigă încredere, nu peste tot.',
  'landing.discovery.chat.q.activityYears.reflect.skipped':
    'Poți lăsa necompletat, nu menționez vechimea ta deocamdată.',
};

export default ro;
