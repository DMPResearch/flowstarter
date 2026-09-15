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
  // ═══════════════════════════════════════════════════════════════════════
  // Everything below was added 2026-09-15 to close the rest of the
  // discovery catalogue's gap: PR #196 translated the funnel's new person
  // block, which made it visible that everything asked before it — the
  // scope gate, the preview step, the brief, the client dashboard — had
  // never been translated at all. See scripts/check-i18n-ro-coverage.mjs
  // and apps/flowstarter-main/src/locales/__tests__/ro-coverage.test.ts,
  // which now fail the build if this happens again.
  //
  // Register: the discovery chat (`landing.discovery.*` outside `.scope.`)
  // uses informal "tu", matching the person block PR #196 already shipped
  // in this same namespace. `landing.discovery.scope.*` and
  // `discoveryCall.*` use formal "dvs", matching the existing
  // `scope.hold.*` strings above. `dashboard.*` and `portrait.*` use
  // informal "tu": both are the client's own space, in the same voice as
  // the chat.
  // ═══════════════════════════════════════════════════════════════════════

  // ─── Policy notices ───────────────────────────────────────────────────
  'moderation.termsOfService': 'Termeni și condiții',
  'moderation.contentGuidelines': 'Ghid de conținut',
  'moderation.inline.title': 'Încălcare a politicii de conținut',

  // ─── The preview link banner ──────────────────────────────────────────
  'domain.preview.availableAt': 'Site-ul tău va fi disponibil la:',
  'domain.preview.customConfigured': 'Domeniu personalizat configurat',
  'domain.preview.hostedOn': 'Găzduit pe',
  'site.preview.worksUntil':
    'Linkul tău de previzualizare este valabil până la {date}',
  'site.preview.expired':
    'Linkul tău de previzualizare a expirat. Site-ul tău complet nu este afectat.',
  'site.preview.heading': 'Previzualizarea ta temporară',

  // ─── The scope gate (landing.discovery.scope.*, in en/discovery-call.ts) ─
  'landing.discovery.scope.checking': 'Verificăm ce ne-ați spus',
  'landing.discovery.scope.checkingBody':
    'Un moment, stabilim exact de ce aveți nevoie.',
  'landing.discovery.scope.question':
    'Acesta este un site care vă prezintă afacerea sau o aplicație în care se autentifică clienții dvs.?',
  'landing.discovery.scope.answer.site': 'Un site care îmi prezintă afacerea',
  'landing.discovery.scope.answer.software':
    'O aplicație în care se autentifică clienții mei',
  'landing.discovery.scope.answer.other': 'Altceva. Vă explic',
  'landing.discovery.scope.answerPlaceholder':
    'Într-o propoziție, la ce ar folosi-o cineva?',
  'landing.discovery.scope.send': 'Trimite',
  'landing.discovery.scope.offer.title': 'Acesta este un proiect personalizat',
  'landing.discovery.scope.offer.body':
    'Ce ați descris nu este un site care vă prezintă afacerea, ci o aplicație construită pentru ea. Nu începem un astfel de proiect de pe un formular și nu vă vom construi o previzualizare care să pretindă altceva.',
  'landing.discovery.scope.offer.studio':
    'Proiectele de acest fel sunt preluate de DMPResearch, studioul lui Darius, și sunt contractate în urma unui apel, nu cumpărate direct de pe pagină. Treizeci de minute, nimic de pregătit. Plecați știind ce presupune proiectul și cât costă, indiferent dacă mergeți mai departe cu noi sau nu.',
  'landing.discovery.scope.review.title': 'Să lămurim mai întâi acest lucru',
  'landing.discovery.scope.review.body':
    'Nu am putut stabili din răspunsurile dvs. dacă este vorba despre un site care vă prezintă afacerea sau despre o aplicație construită pentru ea, iar cele două sunt proiecte diferite, cu prețuri diferite. În loc să ghicim și să construim varianta greșită, preferăm să întrebăm.',
  'landing.discovery.scope.offer.cta': 'Alegeți o oră',
  'landing.discovery.scope.offer.prefilled':
    'Numele și emailul dvs. sunt deja completate.',
  'landing.discovery.scope.offer.emailed':
    'V-am trimis o copie a acestui mesaj pe email, ca să puteți programa mai târziu, dacă acum nu este un moment potrivit.',
  'landing.discovery.scope.offer.fallbackTitle':
    'Spuneți-ne unde vă putem contacta',
  'landing.discovery.scope.offer.fallbackBody':
    'Nu există un calendar de afișat aici, așa că Darius vă va scrie personal pentru a stabili apelul.',
  'landing.discovery.scope.offer.fallbackCta': 'Trimite proiectul meu',

  // ─── The /discovery-call page and its fallback form ───────────────────
  'discoveryCall.meta.title': 'Programează un apel de discovery | Flowstarter',
  'discoveryCall.meta.description':
    'Treizeci de minute cu Darius pentru a stabili amploarea unui proiect personalizat prin DMPResearch. Nimic de pregătit.',
  'discoveryCall.eyebrow': 'Apel de discovery',
  'discoveryCall.headlinePrefix': 'Treizeci de minute.',
  'discoveryCall.headlineFlourish': 'Fără slide-uri, fără scenariu.',
  'discoveryCall.sub':
    'Un apel prin care stabilim exact de ce aveți nevoie și ce presupune. Proiectele personalizate sunt contractate prin DMPResearch, studioul lui Darius, după acest apel, nu înainte de el.',
  'discoveryCall.expect.title': 'Ce se întâmplă la apel',
  'discoveryCall.expect.one':
    'Descrieți problema. Punem întrebările care stabilesc dacă este vorba de o săptămână de lucru sau de un trimestru.',
  'discoveryCall.expect.two':
    'Vă spunem clar dacă acesta este un proiect pe care ar trebui să îl construim și cât ar costa.',
  'discoveryCall.expect.three':
    'Dacă nu ni se potrivește, vă spunem chiar la apel și vă îndrumăm spre altcineva potrivit. Se întâmplă, și nu este o jumătate de oră pierdută.',
  'discoveryCall.bookingTitle': 'Alegeți o oră',
  'discoveryCall.bookingFallback':
    'Calendarul nu se încarcă. Folosiți formularul de mai jos și revenim la dvs. cu câteva variante de oră.',
  'discoveryCall.form.title': 'Spuneți-ne despre proiectul dvs.',
  'discoveryCall.form.body':
    'Nu există un calendar de afișat acum, așa că acest mesaj ajunge direct la Darius, care stabilește personal apelul.',
  'discoveryCall.form.name': 'Numele dvs.',
  'discoveryCall.form.namePlaceholder': 'Sarah Smith',
  'discoveryCall.form.email': 'Email',
  'discoveryCall.form.emailPlaceholder': 'contact@exemplu.com',
  'discoveryCall.form.link': 'Un link, dacă aveți unul',
  'discoveryCall.form.linkPlaceholder': 'https://site-ul-dvs.ro',
  'discoveryCall.form.description': 'Ce anume aveți nevoie să construim?',
  'discoveryCall.form.descriptionPlaceholder':
    'Ce ar trebui să facă și cine l-ar folosi. Câteva propoziții sunt suficiente.',
  'discoveryCall.form.submit': 'Trimite proiectul meu',
  'discoveryCall.form.sending': 'Se trimite…',
  'discoveryCall.form.successTitle': 'L-am primit.',
  'discoveryCall.form.successBody':
    'Darius vă va scrie în cel mult o zi lucrătoare pentru a stabili apelul. Verificați căsuța de email pentru confirmare.',
  'discoveryCall.form.error':
    'Ceva nu a funcționat. Vă rugăm încercați din nou.',

  // ─── The discovery funnel: nav, steps, subscription tiers ─────────────
  'landing.discovery.eyebrow': 'Discovery gratuit: câteva minute',
  'landing.discovery.nav.back': 'Înapoi',
  'landing.discovery.nav.continue': 'Continuă',
  'landing.discovery.nav.bookCall': 'programează apelul meu',
  'landing.discovery.nav.saveAndBook':
    'Preferi să vorbim mai întâi? Salvează și programează un apel',
  'landing.discovery.nav.submitting': 'Se salvează…',
  'landing.discovery.nav.payPrefix': 'Plătește',
  'landing.discovery.nav.redirecting':
    'Te redirecționăm către plata securizată…',

  'landing.discovery.steps.about.title':
    'Hai să te cunoaștem, pe tine și afacerea ta',
  'landing.discovery.steps.about.subtitle':
    'Trimitem linkul apelului și mesajele următoare la acest email',
  'landing.discovery.steps.business.title': 'Cu ce se ocupă afacerea ta?',
  'landing.discovery.steps.business.subtitle':
    'Câteva propoziții sunt suficiente. Ce faci și pentru cine.',
  'landing.discovery.steps.goals.title': 'Care e scopul site-ului?',
  'landing.discovery.steps.goals.subtitle':
    'Ne ajută să-ți recomandăm pachetul potrivit și să pregătim apelul',
  'landing.discovery.steps.commerce.title': 'Vinzi ceva online?',
  'landing.discovery.steps.commerce.subtitle':
    'Alegem cel mai simplu furnizor care acoperă nevoile tale',
  'landing.discovery.steps.recommendation.title':
    'Pachetul recomandat pentru tine',
  'landing.discovery.steps.recommendation.subtitle':
    'Pe baza răspunsurilor tale. Poți ajusta înainte de programare, iar amploarea proiectului o confirmăm la apel',
  'landing.discovery.steps.subscription.title':
    'Alege planul tău de mentenanță',
  'landing.discovery.steps.subscription.subtitle':
    'Separat de construcția inițială. Controlează capacitățile editorului și îl poți schimba oricând',
  'landing.discovery.steps.subscription.subtitleStore':
    'Magazinul tău rulează pe un plan dedicat, construit pentru vânzare, nu pe pachetele standard de editor',
  'landing.discovery.subscription.tiers.starter': 'Starter',
  'landing.discovery.subscription.tiers.pro': 'Pro',
  'landing.discovery.subscription.tiers.max': 'Max',
  'landing.discovery.subscription.popular': 'Popular',
  'landing.discovery.subscription.cadence.monthly': 'Lunar',
  'landing.discovery.subscription.cadence.yearly': 'Anual',
  'landing.discovery.subscription.footnote':
    'Prima lună este gratuită. Fără angajament, așa că poți urca sau coborî planul oricând vrei.',
  'landing.discovery.subscription.storeEyebrow': 'Plan dedicat pentru magazin',
  'landing.discovery.subscription.storeName': 'Commerce',
  'landing.discovery.subscription.storeOps':
    'suport pentru magazin, ajutor la comenzi și catalog',
  'landing.discovery.subscription.storeNote':
    'Un plan dedicat pentru magazin, cu editare de produse și colecții, plus sincronizare cu furnizorul și gestionarea comenzilor. Construit pentru a rula un magazin, nu doar un site de prezentare.',
  'landing.discovery.steps.info.title':
    'Câteva lucruri înainte să începem construcția',
  'landing.discovery.steps.preview.title': 'Site-ul tău, în construcție',
  'landing.discovery.steps.deposit.title': 'Pornește construcția completă',
  'landing.discovery.steps.preview.subtitle':
    'Generat din răspunsurile tale, în câteva secunde. Varianta reală este proiectată corect la apel',

  // ─── The funnel's in-page preview pane + build status ─────────────────
  'landing.discovery.preview.fallbackName': 'Afacerea ta',
  'landing.discovery.preview.fallbackTagline':
    'O muncă ce merită arătată, în sfârșit online',
  'landing.discovery.preview.audiencePrefix': 'Pentru',
  'landing.discovery.preview.generating':
    'Construim o primă variantă a site-ului tău din răspunsurile tale…',
  'landing.discovery.preview.build.s1': 'Citim răspunsurile tale',
  'landing.discovery.preview.build.s2':
    'Alegem un aspect potrivit pentru afacerea ta',
  'landing.discovery.preview.build.s3': 'Scriem secțiunile tale',
  'landing.discovery.preview.build.s4': 'Asamblăm pagina',
  'landing.discovery.preview.editorTitle':
    'Încearcă editorul: cere modificări în cuvinte simple',
  'landing.discovery.preview.editsLeft': 'modificări rămase',
  'landing.discovery.preview.editorPlaceholder':
    'de ex. „fă titlul mai puternic” sau „folosește un accent turcoaz”',
  'landing.discovery.preview.apply': 'Aplică',
  'landing.discovery.preview.applying': 'Se aplică…',
  'landing.discovery.preview.editFailed':
    'Nu am putut aplica modificarea. Încearcă să o reformulezi.',
  'landing.discovery.preview.limitReached':
    'Ai folosit toate modificările demo. Editorul real nu are limită.',
  'landing.discovery.preview.editorUnavailable':
    'Editarea live este dezactivată în acest mediu: aceasta este o previzualizare statică.',
  'landing.discovery.preview.deferredNow': 'Previzualizarea ta este pe drum',
  'landing.discovery.preview.deferredMessage':
    'Nu am putut porni acum previzualizarea live. Nu se pierde nimic: o construim manual și ți-o trimitem pe email în scurt timp.',
  'landing.discovery.preview.disclaimer':
    'O previzualizare funcțională, construită din răspunsurile tale. Site-ul complet este construit de echipa ta de agenți după plata avansului de 20%, verificat de noi înainte de a fi publicat, și vine cu un editor fără limită de modificări.',
  'landing.discovery.preview.paneTitle': 'Site-ul tău prinde formă',
  'landing.discovery.preview.paneSkeleton':
    'Site-ul tău apare aici pe măsură ce agenții îl construiesc. Nimic din acest panou nu este real încă.',
  'landing.discovery.preview.askForChange': 'Cere o modificare',
  'landing.discovery.preview.pane.title': 'Previzualizarea ta',
  'landing.discovery.preview.pane.caption':
    'Forma site-ului tău, din răspunsurile tale. Se completează pe măsură ce discutăm, apoi agenții construiesc varianta reală pe baza ei.',
  'landing.discovery.preview.pane.knownTitle': 'Ce știm până acum',
  'landing.discovery.preview.pane.factName': 'Nume',
  'landing.discovery.preview.pane.factBusiness': 'Afacere',
  'landing.discovery.preview.pane.factDoes': 'Faci',
  'landing.discovery.preview.pane.factLinks': 'Linkuri',
  'landing.discovery.preview.pane.factStyle': 'Stil',
  'landing.discovery.preview.pane.factPages': 'Pagini',
  'landing.discovery.preview.pane.factEmpty': 'Încă nu',
  'landing.discovery.preview.pane.stripCount':
    '{done} din {total} detalii completate',
  'landing.discovery.preview.pane.section.hero': 'Deschidere',
  'landing.discovery.preview.pane.section.services': 'Ce oferi',
  'landing.discovery.preview.pane.section.menu': 'Meniu',
  'landing.discovery.preview.pane.section.work': 'Munca ta',
  'landing.discovery.preview.pane.section.products': 'Produse',
  'landing.discovery.preview.pane.section.booking': 'Programări',
  'landing.discovery.preview.pane.section.about': 'Despre',
  'landing.discovery.preview.pane.section.testimonials': 'Ce spun oamenii',
  'landing.discovery.preview.pane.section.contact': 'Contact',

  // ─── Brand: colours + voice, read from the visitor's own profiles ─────
  'landing.discovery.brand.title': 'Culorile și vocea ta',
  'landing.discovery.brand.paletteFrom.image':
    'Preluate din propriile tale poze și din profilul tău.',
  'landing.discovery.brand.paletteFrom.tone':
    'Din cuvintele de stil pe care le-ai ales, până putem citi un profil.',
  'landing.discovery.brand.paletteFrom.default':
    'O paletă implicită, discretă. Adaugă un link sau o poză și voi folosi propriile tale culori.',
  'landing.discovery.brand.voiceFrom.phrased':
    'Preluată din propriile tale cuvinte.',
  'landing.discovery.brand.voiceFrom.chips':
    'Din cuvintele de stil pe care le-ai ales.',
  'landing.discovery.brand.voiceFrom.default':
    'Simplă și clară, până îmi spui altfel.',
  'landing.discovery.brand.adjust': 'Ajustează',
  'landing.discovery.brand.reading': 'Îți citim profilurile…',
  'landing.discovery.brand.swatch.primary': 'Principală',
  'landing.discovery.brand.swatch.secondary': 'Secundară',
  'landing.discovery.brand.swatch.accent': 'Accent',
  'landing.discovery.brand.swatch.neutral': 'Neutră',
  'landing.discovery.brand.network.instagram': 'Instagram',
  'landing.discovery.brand.network.linkedin': 'LinkedIn',
  'landing.discovery.brand.network.website': 'Site-ul tău',
  'landing.discovery.brand.unavailableTitle': 'Ce nu am putut citi',
  'landing.discovery.brand.unavailable.login_required':
    'nu arată nimic cuiva care nu este autentificat, așa că nu am putut vedea',
  'landing.discovery.brand.unavailable.blocked':
    'a refuzat cererea, ceea ce are dreptul să facă',
  'landing.discovery.brand.unavailable.not_found':
    'nu a fost găsit. Merită verificat linkul',
  'landing.discovery.brand.unavailable.timeout': 'nu a răspuns la timp',
  'landing.discovery.brand.unavailable.network_error': 'nu a putut fi accesat',
  'landing.discovery.brand.unavailable.server_error': 'are probleme la ei',
  'landing.discovery.brand.unavailable.too_large':
    'a trimis mai mult decât sunt dispus să citesc',
  'landing.discovery.brand.unavailable.not_given': 'nu a fost oferit',
  'landing.discovery.brand.pictureAsk':
    'Nu am putut citi niciunul dintre profilurile tale. Încarcă un logo sau o poză cu tine și voi lua culorile de acolo.',
  'landing.discovery.brand.pictureCta': 'Adaugă un logo sau o poză',
  'landing.discovery.brand.pictureRights':
    'Prin încărcare confirmi că această poză este a ta sau că ai permisiunea să o folosești.',
  'landing.discovery.brand.consent.label':
    'Folosește poza mea de profil pe site',
  'landing.discovery.brand.consent.from': 'Am găsit-o pe',
  'landing.discovery.brand.consent.note':
    'Debifează și o lăsăm deoparte, urmând să îți cerem o poză.',
  'landing.discovery.brand.consent.alt': 'Poza ta de profil',
  'landing.discovery.brand.pictureDone':
    'Am reținut. Culorile tale vin acum din propria ta poză.',

  // ─── Connecting an account for the photo ───────────────────────────────
  'landing.discovery.chat.q.connectPortrait.prompt':
    'Încă una, și e opțională. Conectează LinkedIn sau Instagram ca previzualizarea să-ți poată folosi poza, și îți pun fața pe site în loc de un substitut.',
  'landing.discovery.connect.title': 'Conectează un cont pentru poza ta',
  'landing.discovery.connect.note':
    'Preluăm poza, numele și titlul tău, și nimic altceva. Poți sări peste acest pas și ne trimiți o poză mai târziu.',
  'landing.discovery.connect.linkedin': 'Conectează LinkedIn',
  'landing.discovery.connect.instagram': 'Conectează Instagram',
  'landing.discovery.connect.unavailable': 'Nu este disponibil încă',
  'landing.discovery.connect.unavailableNote':
    'Această conexiune nu este activată încă. Sari peste ea și îți vom cere o poză.',
  'landing.discovery.connect.busy': 'Te ducem acolo',
  'landing.discovery.connect.connected':
    'Am reținut. Poza ta e pe previzualizare.',
  'landing.discovery.connect.cancelled': 'Nicio problemă. Îți vom cere o poză.',
  'landing.discovery.connect.failed':
    'Nu am primit un răspuns. Sari peste ea și îți vom cere o poză.',
  'landing.discovery.connect.instagramPersonal':
    'Instagram permite acest acces doar conturilor de creator și business. Un cont personal nu poate fi citit deloc, așa că LinkedIn sau o poză este soluția.',
  'landing.discovery.connect.skip': 'Sari peste',

  // ─── The intake conversation: header, stepper, composer ────────────────
  'landing.discovery.chat.title': 'Hai să vorbim despre site-ul tău',
  'landing.discovery.chat.intro':
    'Bună, sunt agentul tău Flowstarter. Câteva întrebări scurte, iar la final primești o previzualizare funcțională a site-ului tău. Sari peste orice nu vrei să răspunzi.',
  'landing.discovery.chat.agentName': 'Agent Flowstarter',
  'landing.discovery.chat.logLabel': 'Conversația ta',
  'landing.discovery.chat.progressLabel': 'Întrebări răspunse',
  'landing.discovery.chat.progressCount':
    '{done} din {total} întrebări răspunse',
  'landing.discovery.stepper.label': 'Progresul discovery',
  'landing.discovery.stepper.name': 'Numele tău',
  'landing.discovery.stepper.contact': 'Emailul tău',
  'landing.discovery.stepper.business': 'Ce faci',
  'landing.discovery.stepper.links': 'Linkurile tale',
  'landing.discovery.stepper.preview': 'Previzualizare',
  'landing.discovery.stepper.deposit': 'Planul tău',
  'landing.discovery.stepper.about': 'Despre tine',
  'landing.discovery.stepper.goals': 'Scop și stil',
  'landing.discovery.stepper.commerce': 'Vânzare online',
  'landing.discovery.stepper.recommendation': 'Planul tău',
  'landing.discovery.stepper.subscription': 'Plan de mentenanță',
  'landing.discovery.stepper.info': 'Detalii',
  'landing.discovery.stepper.position': 'Pasul {n} din {total}: {label}',
  'landing.discovery.chat.composerLabel': 'Răspunsul tău',
  'landing.discovery.chat.composerPlaceholder': 'Scrie răspunsul tău…',
  'landing.discovery.chat.send': 'Trimite',
  'landing.discovery.chat.done': 'Gata',
  'landing.discovery.chat.confirm': 'Arată bine, continuă',
  'landing.discovery.chat.edit': 'Editează',
  'landing.discovery.chat.reask': 'Sigur, hai să o luăm de la capăt cu asta.',
  'landing.discovery.chat.skip': 'Sari peste aceasta',
  'landing.discovery.chat.skipped': 'Sărită deocamdată',
  'landing.discovery.chat.tokens.you': 'acolo',
  'landing.discovery.chat.tokens.business': 'afacerea ta',

  // ─── Validation errors ──────────────────────────────────────────────────
  'landing.discovery.chat.errors.required':
    'Chiar am nevoie de acest răspuns, îmi pare rău. E unul dintre puținele fără de care nu pot construi nimic.',
  'landing.discovery.chat.errors.fullName':
    'Un prenume e suficient. Am nevoie doar de ceva cu care să te strig.',
  'landing.discovery.chat.errors.email':
    'Nu pare o adresă de email validă. Poți verifica?',
  'landing.discovery.chat.errors.links':
    'Am nevoie de un singur link: Instagram, LinkedIn sau un site pe care îl ai deja. De acolo îți preiau culorile și vocea.',
  'landing.discovery.chat.errors.description':
    'Puțin mai mult de atât, dacă poți: o propoziție sau două sunt suficiente.',
  'landing.discovery.chat.errors.offer':
    'Doar un rând sau două despre ce cumpără de fapt cineva de la tine. Nu pot scrie o secțiune de servicii din nimic fără să inventez.',
  'landing.discovery.chat.errors.goal':
    'Alege cel puțin una, sau spune-mi cu propriile tale cuvinte.',
  'landing.discovery.chat.errors.choice':
    'Nu am înțeles răspunsul. Cel mai simplu e să atingi una dintre opțiunile de mai sus.',

  // ─── The questions ──────────────────────────────────────────────────────
  'landing.discovery.chat.q.fullName.prompt': 'Mai întâi: cum să-ți spun?',
  'landing.discovery.chat.q.email.prompt':
    'Unde să trimit previzualizarea, odată gata?',
  'landing.discovery.chat.q.businessName.prompt':
    'Și cum se numește afacerea? Dacă nu te-ai decis încă asupra unui nume, sari peste. Revenim la asta.',
  'landing.discovery.chat.q.description.prompt':
    'Acum cea mai importantă: cu ce se ocupă de fapt {business}? Cu propriile tale cuvinte, o propoziție sau două.',
  'landing.discovery.chat.q.offer.prompt':
    'Și ce cumpără de fapt cineva de la tine? Numește ce vinzi sau ce faci, așa cum le-ai numi unui client.',
  'landing.discovery.chat.q.offer.placeholder':
    'Ședințe de coaching, un program de șase săptămâni, fotografie de nuntă…',
  'landing.discovery.chat.q.industry.prompt':
    'Care dintre acestea se apropie cel mai mult de domeniul tău? Atinge una, sau scrie-o dacă nu e niciuna dintre ele.',
  'landing.discovery.chat.q.targetAudience.prompt':
    'Pe cine vrei să atragi? Descrie-i așa cum i-ai descrie unui prieten.',
  'landing.discovery.chat.q.links.prompt':
    'Ai ceva ce pot vedea: Instagram, LinkedIn, un site pe care îl ai deja? Adaugă ce ai și îți preiau culorile și vocea de acolo.',
  'landing.discovery.chat.q.links.placeholder':
    'instagram.com/afacereata, linkedin.com/in/tine, siteultau.com',
  'landing.discovery.chat.q.websiteIsOwnSite.prompt':
    'O verificare rapidă: acel site este al tău? Dacă da, îi folosesc numele pentru afacere; dacă e doar o referință, îl las deoparte de la nume.',
  'landing.discovery.chat.q.goal.prompt':
    'Ce ar trebui să facă de fapt site-ul pentru tine? Alege câte ți se potrivesc, sau adaugă-le pe ale tale.',
  'landing.discovery.chat.q.goal.placeholder': 'Altceva ce vrei să facă…',
  'landing.discovery.chat.q.brandTone.prompt':
    'Ce impresie ar trebui să lase {business}? Alege câteva cuvinte.',
  'landing.discovery.chat.q.brandTone.placeholder': 'Adaugă un cuvânt al tău…',
  'landing.discovery.chat.q.pageCount.prompt':
    'Cam cât de mare ar trebui să fie site-ul?',
  'landing.discovery.chat.q.timeline.prompt': 'Când ai vrea să fie live?',
  'landing.discovery.chat.q.commerceMode.prompt':
    'Vinzi ceva prin intermediul site-ului?',
  'landing.discovery.chat.q.catalogSize.prompt':
    'Cam câte produse sau servicii?',
  'landing.discovery.chat.q.calComUrl.prompt':
    'Dacă deja programezi clienți pe Cal.com, adaugă linkul tău de programări. Lasă necompletat dacă nu folosești încă Cal.com, îl poți adăuga mai târziu din proiectul tău.',
  'landing.discovery.chat.q.customIntegrations.prompt':
    'Mai trebuie să se conecteze cu ceva? Plăți, o listă de email, o zonă pentru membri. Programările sunt acoperite mai sus.',
  'landing.discovery.chat.q.selectedTier.prompt':
    'Am tot ce am nevoie. Iată pachetul spre care indică răspunsurile tale. Schimbă-l dacă preferi altul.',
  'landing.discovery.chat.q.subscription.prompt':
    'O ultimă decizie: planul lunar. E separat de construcție și stabilește cât de mult poți schimba tu însuți ulterior.',

  // ─── What the agent says back, before the next question ───────────────
  'landing.discovery.chat.thinking': 'Se gândește',
  'landing.discovery.chat.typeInstead': 'Sau scrie răspunsul tău…',
  'landing.discovery.chat.tokens.and': 'și',
  'landing.discovery.chat.reflect.skipped.0':
    'Nicio problemă, revenim la asta.',
  'landing.discovery.chat.reflect.skipped.1':
    'Mi se pare bine. Mergem mai departe.',
  'landing.discovery.chat.reflect.skipped.2':
    'Sărit. Nimic de aici nu e bătut în cuie.',
  'landing.discovery.chat.q.fullName.reflect':
    'Salut, {name}, mă bucur să te cunosc.',
  'landing.discovery.chat.q.email.reflect':
    'Am reținut. Previzualizarea ajunge la {answer} odată construită, și nicăieri altundeva.',
  'landing.discovery.chat.q.businessName.reflect':
    '{answer}. Acesta e numele pe care îl folosesc peste tot unde site-ul spune cine ești.',
  'landing.discovery.chat.q.businessName.reflect.skipped':
    'E în regulă dacă nu ai un nume încă. Voi spune „afacerea ta” deocamdată și îl stabilim mai târziu.',
  'landing.discovery.chat.q.description.reflect':
    '„{quote}.” Acesta e rândul în jurul căruia scriu tot site-ul.',
  'landing.discovery.chat.q.offer.reflect':
    '„{quote}.” Astea sunt lucrurile pe care site-ul le va vinde, și nu va oferi nimic ce nu ai numit acum.',
  'landing.discovery.chat.q.industry.reflect':
    '{answer}, am reținut. Asta îmi spune de la ce aspecte și fotografii să pornesc.',
  'landing.discovery.chat.q.industry.reflect.skipped':
    'Nu e nevoie de nicio categorie. Mă iau după ce mi-ai spus.',
  'landing.discovery.chat.q.targetAudience.reflect':
    'Deci site-ul se adresează lui {quote}. Fiecare titlu e scris pentru ei, nu pentru toată lumea.',
  'landing.discovery.chat.q.targetAudience.reflect.skipped':
    'Bine, scriu pentru oamenii spre care indică descrierea ta.',
  'landing.discovery.chat.q.links.reflect':
    'Mulțumesc. Le citesc înainte să scriu vreun cuvânt, ca site-ul să sune ca tine.',
  'landing.discovery.chat.q.links.reflect.skipped':
    'Nicio problemă. Lucrez din propriile tale cuvinte.',
  'landing.discovery.chat.q.websiteIsOwnSite.reflect.yes':
    'Bine de știut. Preiau numele afacerii de pe acel site.',
  'landing.discovery.chat.q.websiteIsOwnSite.reflect.no':
    'Am notat, acela e doar o referință, nu al tău. Numesc afacerea din ce mi-ai spus deja.',
  'landing.discovery.chat.q.goal.reflect':
    'Deci rolul lui este să {list}. Asta decide ce apare în partea de sus a paginii.',
  'landing.discovery.chat.q.brandTone.reflect':
    '{answer}: asta e vocea, atunci. Păstrez fiecare rând în acest ton.',
  'landing.discovery.chat.q.brandTone.reflect.skipped':
    'Aleg un ton din felul în care ai descris afacerea. Îl poți schimba mai târziu.',
  'landing.discovery.chat.q.pageCount.reflect.lt-5':
    'Un site mic și concentrat. Acestea convertesc de obicei cel mai bine.',
  'landing.discovery.chat.q.pageCount.reflect.5-7':
    'Cinci până la șapte pagini, configurația clasică.',
  'landing.discovery.chat.q.pageCount.reflect.8-15':
    'Un site propriu-zis cu mai multe pagini. Planific navigarea cu grijă.',
  'landing.discovery.chat.q.pageCount.reflect.15+':
    'Unul mare. Îl structurez ca lucrurile să rămână ușor de găsit.',
  'landing.discovery.chat.q.pageCount.reflect.unsure':
    'Nu trebuie să decizi acum. Propun o listă de pagini în previzualizare.',
  'landing.discovery.chat.q.pageCount.reflect.skipped':
    'Propun o listă de pagini în previzualizare, iar tu o poți ajusta.',
  'landing.discovery.chat.q.timeline.reflect.asap':
    'Rapid, atunci. Previzualizarea e la câteva minute distanță, iar construcția urmează după avans.',
  'landing.discovery.chat.q.timeline.reflect.4-weeks':
    'Patru săptămâni e un timp confortabil. Loc suficient pentru revizuiri.',
  'landing.discovery.chat.q.timeline.reflect.1-3-months':
    'Fără grabă, atunci. Avem timp să facem conținutul cum trebuie.',
  'landing.discovery.chat.q.timeline.reflect.flexible':
    'Flexibil e bine. Mergem în ritmul tău.',
  'landing.discovery.chat.q.commerceMode.reflect.none':
    'Fără magazin, atunci. Asta ține construcția mai simplă și mai ieftină.',
  'landing.discovery.chat.q.commerceMode.reflect.few-services':
    'Câteva oferte plătite. Fiecare primește propria secțiune cu un îndemn clar la acțiune.',
  'landing.discovery.chat.q.commerceMode.reflect.digital':
    'Produse digitale. Planific un magazin cu livrare instantă după plată.',
  'landing.discovery.chat.q.commerceMode.reflect.physical':
    'Produse fizice. Planific un magazin cu livrare și stoc în minte.',
  'landing.discovery.chat.q.commerceMode.reflect.mixed':
    'Un pic din ambele. Configurez un magazin care gestionează atât comenzi digitale, cât și livrate.',
  'landing.discovery.chat.q.catalogSize.reflect.1-5':
    'Un catalog mic. Fiecare produs are loc să strălucească.',
  'landing.discovery.chat.q.catalogSize.reflect.6-25':
    'Un catalog de mărime medie. Adaug categorii ca să rămână ușor de răsfoit.',
  'landing.discovery.chat.q.catalogSize.reflect.26-100':
    'Un catalog consistent. Filtrele și căutarea intră de la început.',
  'landing.discovery.chat.q.catalogSize.reflect.100+':
    'Un catalog mare. Planific căutare, filtre și import în masă.',
  'landing.discovery.chat.q.catalogSize.reflect.unsure':
    'Putem stabili dimensiunea catalogului mai târziu. Magazinul se scalează oricum.',
  'landing.discovery.chat.q.calComUrl.reflect':
    'Link de programări salvat. Butoanele de programare de pe site îl vor deschide.',
  'landing.discovery.chat.q.calComUrl.reflect.skipped':
    'Fără link de programări deocamdată. Poți adăuga unul mai târziu din proiectul tău.',
  'landing.discovery.chat.q.customIntegrations.reflect':
    'Am notat. Semnalez asta pentru construcție, ca să fie planificată, nu adăugată ulterior.',
  'landing.discovery.chat.q.customIntegrations.reflect.skipped':
    'Nimic suplimentar de conectat. Simplu e bine.',
  'landing.discovery.chat.q.selectedTier.reflect.starter':
    'Starter, atunci. Simplu și rapid de lansat.',
  'landing.discovery.chat.q.selectedTier.reflect.pro':
    'Pro. O alegere bună pentru un site care are nevoie de loc de creștere.',
  'landing.discovery.chat.q.selectedTier.reflect.commerce':
    'Commerce. Planul de magazin vine inclus.',
  'landing.discovery.chat.q.selectedTier.reflect.custom':
    'Personalizat. Cineva din echipa noastră va stabili amploarea proiectului împreună cu tine înainte să construim ceva.',

  // ─── Field labels, hints, placeholders ──────────────────────────────────
  'landing.discovery.fields.fullName': 'Numele tău',
  'landing.discovery.fields.email': 'Email',
  'landing.discovery.fields.businessName': 'Numele afacerii',
  'landing.discovery.fields.description': 'Într-o propoziție sau două',
  'landing.discovery.fields.industry': 'Domeniu',
  'landing.discovery.industryOther': 'Altul',
  'landing.discovery.fields.targetAudience': 'Public țintă',
  'landing.discovery.fields.instagramUrl': 'Profil Instagram',
  'landing.discovery.fields.linkedinUrl': 'Profil LinkedIn',
  'landing.discovery.fields.goal': 'Obiective',
  'landing.discovery.fields.secondaryGoals': 'Obiective secundare (opțional)',
  'landing.discovery.hints.secondaryGoals':
    'Orice altceva ar trebui să facă site-ul, pe lângă obiectivul principal',
  'landing.discovery.fields.brandTone': 'Tonul brandului',
  'landing.discovery.fields.pageCount': 'Număr aproximativ de pagini',
  'landing.discovery.fields.timeline': 'Termen',
  'landing.discovery.fields.commerceMode': 'Ce va vinde site-ul?',
  'landing.discovery.fields.catalogSize': 'Câte produse / servicii?',
  'landing.discovery.fields.calComUrl': 'Link de programări Cal.com',
  'landing.discovery.fields.customIntegrations':
    'Ceva personalizat ar trebui să știm?',
  'landing.discovery.hints.businessName':
    'Opțional: lasă necompletat dacă nu ai ales încă un nume',
  'landing.discovery.hints.description':
    'Limbaj simplu. Ce faci și pentru cine',
  'landing.discovery.hints.socialProfiles':
    'Opțional. Folosim conținutul public al afacerii ca să învățăm vocea și direcția vizuală.',
  'landing.discovery.hints.pageCount':
    'Estimare aproximativă: o rafinăm la apel',
  'landing.discovery.hints.customIntegrations':
    'Plăți, liste de email, zone pentru membri, dar nu Cal.com (are propriul câmp)',
  'landing.discovery.hints.calComUrl':
    'Exemplu: https://cal.com/numele-tau/intro',
  'landing.discovery.placeholders.fullName': 'Maria Ionescu',
  'landing.discovery.placeholders.email': 'maria@exemplu.com',
  'landing.discovery.placeholders.businessName': 'Clinica Dentară Smile',
  'landing.discovery.placeholders.description':
    'de ex. Clinică dentară boutique în Cluj, cu servicii de cosmetică dentară și pediatrie',
  'landing.discovery.placeholders.industry': 'Alege domeniul tău…',
  'landing.discovery.placeholders.industryOther': 'Spune-ne domeniul tău',
  'landing.discovery.placeholders.targetAudience':
    'Cine sunt clienții tăi ideali, în cuvinte simple',
  'landing.discovery.placeholders.calComUrl':
    'https://cal.com/numele-tau/intro',
  'landing.discovery.placeholders.customIntegrations':
    'de ex. linkuri de plată Stripe, Mailchimp pentru newslettere, puncte de ridicare FANBox',

  // ─── Multiple-choice options ────────────────────────────────────────────
  'landing.discovery.options.goal.leads.label': 'Obține clienți potențiali',
  'landing.discovery.options.goal.leads.sub':
    'Primește cereri de contact și câștigă mai multe solicitări',
  'landing.discovery.options.goal.sales.label': 'Vinde produse',
  'landing.discovery.options.goal.sales.sub':
    'Generează achiziții de produse fizice sau digitale',
  'landing.discovery.options.goal.bookings.label': 'Primește programări',
  'landing.discovery.options.goal.bookings.sub':
    'Ședințe, programări, cursuri, consultații',
  'landing.discovery.options.goal.portfolio.label': 'Prezintă-ți munca',
  'landing.discovery.options.goal.portfolio.sub':
    'Portofoliu, studii de caz, prezență de brand',
  'landing.discovery.options.tone.professional': 'Profesionist',
  'landing.discovery.options.tone.bold': 'Îndrăzneț',
  'landing.discovery.options.tone.friendly': 'Prietenos',
  'landing.discovery.options.tone.minimal': 'Minimalist',
  'landing.discovery.options.pages.lt-5.label': 'Sub 5',
  'landing.discovery.options.pages.lt-5.sub':
    'O singură pagină sau site simplu',
  'landing.discovery.options.pages.5-7.label': '5 – 7',
  'landing.discovery.options.pages.5-7.sub':
    'Site standard de prezentare servicii',
  'landing.discovery.options.pages.8-15.label': '8 – 15',
  'landing.discovery.options.pages.8-15.sub':
    'Cu mai multe pagini sau bazat pe conținut',
  'landing.discovery.options.pages.15+.label': '15+',
  'landing.discovery.options.pages.15+.sub': 'Site amplu, blog, locații',
  'landing.discovery.options.pages.unsure.label': 'Nu sunt sigur',
  'landing.discovery.options.pages.unsure.sub': 'Stabilim asta la apel',
  'landing.discovery.options.ownSite.yes': 'Da',
  'landing.discovery.options.ownSite.no': 'Nu',
  'landing.discovery.options.timeline.asap': 'Cât mai repede',
  'landing.discovery.options.timeline.4-weeks': 'În 4 săptămâni',
  'landing.discovery.options.timeline.1-3-months': '1 – 3 luni',
  'landing.discovery.options.timeline.flexible': 'Flexibil',
  'landing.discovery.options.commerce.none.label': 'Fără produse',
  'landing.discovery.options.commerce.none.sub':
    'Doar prezență de brand și colectare de clienți potențiali',
  'landing.discovery.options.commerce.few-services.label':
    'Câteva oferte plătite',
  'landing.discovery.options.commerce.few-services.sub':
    'Permite clienților să plătească servicii sau ședințe individuale online',
  'landing.discovery.options.commerce.digital.label': 'Produse digitale',
  'landing.discovery.options.commerce.digital.sub':
    'Cursuri, descărcări, șabloane, software',
  'landing.discovery.options.commerce.physical.label': 'Produse fizice',
  'landing.discovery.options.commerce.physical.sub':
    'Produse expediate, cu stoc, mărimi sau opțiuni, și livrare',
  'landing.discovery.options.commerce.mixed.label': 'Combinație a celor două',
  'landing.discovery.options.commerce.mixed.sub':
    'Catalog fizic plus completări digitale',
  'landing.discovery.options.catalog.1-5': '1 – 5',
  'landing.discovery.options.catalog.6-25': '6 – 25',
  'landing.discovery.options.catalog.26-100': '26 – 100',
  'landing.discovery.options.catalog.100+': '100+',
  'landing.discovery.options.catalog.unsure': 'Nu sunt sigur',

  // ─── Tiers + recommendation card ────────────────────────────────────────
  'landing.discovery.tiers.starter.name': 'Starter',
  'landing.discovery.tiers.starter.tagline':
    'Site de prezentare rafinat, fără magazin online',
  'landing.discovery.tiers.pro.name': 'Pro',
  'landing.discovery.tiers.pro.tagline':
    'Site cu mai multe pagini și oferte plătite simple',
  'landing.discovery.tiers.commerce.name': 'Commerce',
  'landing.discovery.tiers.commerce.tagline':
    'Un magazin online complet cu produsele tale',
  'landing.discovery.tiers.custom.name': 'Personalizat',
  'landing.discovery.tiers.custom.tagline':
    'O construcție pe măsură pentru cerințe neobișnuite',
  'landing.discovery.recommendation.eyebrow': 'Cea mai potrivită pentru tine',
  'landing.discovery.recommendation.setupFrom': 'Configurare de la',
  'landing.discovery.recommendation.from': 'de la',
  'landing.discovery.recommendation.bestMatchBadge': 'Potrivire',
  'landing.discovery.recommendation.overrideLabel':
    'Vrei alt pachet? Alege unul, și discutăm la apel',
  'landing.discovery.recommendation.footnote':
    'Toate prețurile sunt puncte de plecare. Amploarea finală se stabilește la apelul de discovery.',
  'landing.discovery.recommendation.deposit.title':
    'Nicio plată în etapa de discovery',
  'landing.discovery.recommendation.deposit.body':
    'Mai întâi creăm previzualizarea ta personalizată și confirmăm oferta finală. Când o aprobi, un avans de 20% blochează designul și pornește construcția completă. Restul de 80% este datorat după verificarea finală.',
  'landing.discovery.recommendation.reasons.customIntegrations':
    'Ai menționat servicii specializate sau cerințe neobișnuite, așa că ar trebui să le planificăm împreună',
  'landing.discovery.recommendation.reasons.physicalCatalog':
    'O gamă mai mare de produse are nevoie de stoc și livrare integrate',
  'landing.discovery.recommendation.reasons.digitalCatalog':
    'O gamă de produse digitale are nevoie de livrare securizată, gestionarea taxelor și o zonă pentru clienți',
  'landing.discovery.recommendation.reasons.simplePayments':
    'Pro se potrivește bine când clienții trebuie să plătească online pentru câteva oferte',
  'landing.discovery.recommendation.reasons.multiPage':
    'Un site mai amplu are nevoie de mai multă muncă de design și de un mod mai clar de navigare pentru vizitatori',
  'landing.discovery.recommendation.reasons.contentDriven':
    'Pro oferă unui site axat pe clienți potențiali mai mult spațiu pentru conținut util și articole',
  'landing.discovery.recommendation.reasons.servicePresentation':
    'Un site de prezentare curat și rapid este exact ce oferă Starter',
  'landing.discovery.recommendation.reasons.bookingFriendly':
    'Starter funcționează bine când clienții au nevoie doar să facă programări',
  'landing.discovery.recommendation.reasons.portfolioFriendly':
    'Un portofoliu nu are nevoie de costul sau complexitatea unui magazin online',
  'landing.discovery.recommendation.reasons.fastTurnaround':
    'Termen strâns: stabilim un proiect pe care îl putem livra în săptămâni, nu în luni',
  'landing.discovery.recommendation.reasons.default':
    'Cea mai bună potrivire pe baza răspunsurilor tale',

  // ─── The brief's photo-sourcing section (portrait.*) ───────────────────
  'portrait.reason.usable': 'avem poza ta de aici',
  'portrait.reason.not_offered': 'nu ne-ai oferit-o pe aceasta',
  'portrait.reason.not_configured': 'această conexiune nu este activată încă',
  'portrait.reason.not_connected': 'nu ai conectat-o pe aceasta',
  'portrait.reason.no_picture': 'contul nu are nicio poză',
  'portrait.reason.personal_account':
    'Instagram permite acest acces doar conturilor de creator și business',
  'portrait.reason.no_github_handle': 'nimeni nu ne-a dat un profil GitHub',
  'portrait.reason.not_a_person':
    'am găsit o poză, dar nimic de pe pagină nu arată că ești tu',
  'portrait.reason.not_public_url':
    'acea poză nu este una pe care o putem prelua',
  'portrait.reason.below_avatar_floor':
    'acea poză este prea mică pentru a fi folosită oriunde',
  'portrait.reason.size_unknown': 'nu am putut măsura acea poză',
  'portrait.verdict.portrait':
    'Suficient de mare pentru poza principală de pe site-ul tău.',
  'portrait.verdict.avatar':
    'Mică. O putem folosi ca avatar rotund lângă numele tău și nu o vom întinde ca să umple ceva mai mare.',
  'portrait.verdict.too_small':
    'Prea mică pentru a fi folosită oriunde pe site.',
  'portrait.verdict.unknown': 'Nu am putut măsura poza aceasta.',
  'portrait.source.linkedin-openid': 'LinkedIn',
  'portrait.source.instagram-login': 'Instagram',
  'portrait.source.github-avatar': 'GitHub',
  'portrait.source.website-about': 'site-ul tău propriu',
  'portrait.source.instagram-public-og': 'pagina ta publică de Instagram',
  'portrait.brief.found': 'Am găsit o poză de-a ta pe',
  'portrait.brief.use': 'Folosește-o pe aceasta',
  'portrait.brief.replace': 'Înlocuiește',
  'portrait.brief.pending':
    'Nu o punem pe site-ul tău până nu apeși Folosește-o pe aceasta.',
  'portrait.brief.inUse': 'Aceasta este poza pe care o vom folosi.',

  // ─── The client dashboard (dashboard.*) ─────────────────────────────────
  'dashboard.analytics.prospectSingular': 'client potențial',
  'dashboard.analytics.prospectPlural': 'clienți potențiali',
  'dashboard.projects.continueSetup': 'Continuă configurarea',
  'dashboard.projects.inProgress': 'În desfășurare',
  'dashboard.projects.draftPlaceholderName': 'Site fără titlu',
  'dashboard.analytics.businessLeads': 'Clienți potențiali',
  'dashboard.analytics.websiteTraffic': 'Trafic pe site',
  'dashboard.analytics.views': 'Vizualizări',
  'dashboard.stats.yourWebsite': 'Site-ul tău',
  'dashboard.stats.live': 'Live',
  'dashboard.stats.inProgress': 'În desfășurare',
  'dashboard.stats.notStarted': 'Așteaptă demarare',
  'dashboard.stats.bookDiscovery': 'Programează apelul de start ca să începem',
  'dashboard.stats.buildingMessage':
    'Site-ul tău este în construcție. Te anunțăm la fiecare etapă',
  'dashboard.stats.edit': 'Editează',
  'dashboard.stats.view': 'Vezi',
  'dashboard.stats.trafficAppears': 'Datele de trafic se activează la lansare',
  'dashboard.stats.leadsActivate':
    'Urmărirea clienților potențiali se activează la lansare',
  'dashboard.stats.aiCreditsReset': 'Se reînnoiește lunar',
  'dashboard.stats.integrations': 'Integrări',
  'dashboard.stats.integrationsSetup': 'Configurează',
  'dashboard.stats.integrationsAfterLaunch': 'După lansare',
  'dashboard.stats.integrationsConnect': 'Analytics, email, calendar',
  'dashboard.stats.integrationsConnectLater': 'Disponibil după lansare',
  'dashboard.stats.analytics': 'Analytics',
  'dashboard.stats.email': 'Email',
  'dashboard.stats.calendar': 'Calendar',
  'dashboard.stepper.strategy': 'Strategie',
  'dashboard.stepper.strategyDescription':
    'Obiective, public și poziționare stabilite',
  'dashboard.stepper.design': 'Design',
  'dashboard.stepper.designDescription':
    'Brand, aspect și identitate vizuală finalizate',
  'dashboard.stepper.development': 'Dezvoltare',
  'dashboard.stepper.developmentDescription':
    'Pagini construite, conținut adăugat, SEO configurat',
  'dashboard.stepper.launch': 'Lansare',
  'dashboard.stepper.launchDescription':
    'Site live + acces la editorul inteligent',
  'dashboard.stepper.milestone': 'Etapa {number}',
  'dashboard.stepper.done': 'Finalizat',
  'dashboard.stats.aiCapabilities': 'Asistent AI',
  'dashboard.stats.aiCapabilitiesActive': 'Pregătit',
  'dashboard.stats.aiCreditsAvailable':
    'Utilizarea Claude Code este gestionată de Claude',
  'dashboard.stats.aiCapability.copy': 'Rafinează-ți textele',
  'dashboard.stats.aiCapability.sections': 'Optimizează secțiunile',
  'dashboard.stats.aiCapability.seo': 'Îmbunătățește SEO',
  'dashboard.stats.aiCapability.images': 'Îmbunătățește vizualurile',
  'dashboard.stats.aiUnlockedAfterSetup':
    'Disponibil odată ce site-ul tău e live',
  'dashboard.action.requestChange': 'Solicită o modificare',
  'dashboard.action.requestChangeSub':
    'Echipa noastră o implementează în 24 de ore',
  'dashboard.action.uploadAssets': 'Încarcă fișiere',
  'dashboard.action.kickoffTitle': 'Hai să pornim site-ul tău',
  'dashboard.action.kickoffDesc':
    'Un apel de 30 de minute ca să stabilim obiectivele tale. Restul ne ocupăm noi',
  'dashboard.stats.buildPhase': 'Construcție în desfășurare',
  'dashboard.stats.buildPhaseActive': 'În desfășurare',
  'dashboard.stats.currentMilestone': 'Etapa curentă: {phase}',
  'dashboard.greeting.morning': 'Bună dimineața',
  'dashboard.greeting.afternoon': 'Bună ziua',
  'dashboard.greeting.evening': 'Bună seara',
  'dashboard.greeting.night': 'Noapte bună',
  'dashboard.title': 'Prezentare generală a proiectului',
  'dashboard.loading': 'Se încarcă spațiul tău de lucru...',
  'dashboard.stepper.bookCallButton': 'Obține planul meu personalizat',
  'dashboard.details': 'Detalii',
  'dashboard.analytics.visitors': '{count} vizitatori',
  'dashboard.analytics.avgSession': '{minutes}min mediu',
  'dashboard.analytics.conversionRateValue': 'rată de conversie {rate}%',
  'dashboard.analytics.title': 'Prezentare generală Analytics',
  'dashboard.analytics.subtitle':
    'Urmărește-ți progresul și indicatorii de performanță',
};

export default ro;
