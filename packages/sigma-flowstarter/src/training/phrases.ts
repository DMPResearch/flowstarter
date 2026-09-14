/**
 * The synthetic multilingual training set, generated without an LLM.
 *
 * Shape: for every label, a handful of SEEDS per language (the thing being
 * described), crossed with a shared pool of TEMPLATES per language (a way
 * somebody might say it). The cross product is what gets embedded. No model
 * writes any of it, which is the point: the training set is reproducible from
 * this file alone, it diffs in review, and nobody has to wonder whether a
 * generator's style leaked into the geometry.
 *
 * The train/holdout split is by TEMPLATE, not by row. The last two templates
 * of every language are held out, so calibration is measured on phrasings the
 * centroids have never seen — a split by row would only measure how well the
 * mean of a set predicts members of the same set, which is always excellent
 * and always meaningless.
 *
 * These are seeds for an embedding, not matchers. Nothing here is ever
 * compared to a user's text at request time.
 */

import type { LabelledPhrase } from '@flowstarter/sigma-core';
import {
  ACCEPTABLE_USE_HEAD,
  LANGUAGES,
  SCOPE_HEAD,
  type AcceptableUseCategory,
  type Language,
  type ScopeCategory,
} from '../taxonomy.js';

type Seeds = Record<Language, string[]>;

/** How many trailing templates per language are held out of training. */
export const HOLDOUT_TEMPLATES = 2;

/**
 * Shared framings. Both heads see the same business description, so both are
 * trained through the same phrasings — the scope head must not learn to read
 * "I need a website for" as a signal in itself.
 */
export const TEMPLATES: Record<Language, string[]> = {
  en: [
    '{s}',
    'I need a website for {s}',
    'we run {s} and want to go online',
    'landing page for {s}',
    'my business is {s}',
    'build me a site for {s}',
    'our company does {s}',
    '{s} - that is what we do, and we need a web presence',
  ],
  ro: [
    '{s}',
    'am nevoie de un site pentru {s}',
    'avem {s} si vrem sa aparem online',
    'pagina de prezentare pentru {s}',
    'afacerea mea este {s}',
    'construiti-mi un site pentru {s}',
    'firma noastra se ocupa de {s}',
    '{s} - asta facem, si avem nevoie de prezenta web',
  ],
  de: [
    '{s}',
    'ich brauche eine Website für {s}',
    'wir betreiben {s} und wollen online gehen',
    'Landingpage für {s}',
    'mein Geschäft ist {s}',
    'baut mir eine Seite für {s}',
    'unsere Firma macht {s}',
    '{s} - das machen wir, und wir brauchen eine Webpräsenz',
  ],
  fr: [
    '{s}',
    "j'ai besoin d'un site pour {s}",
    'nous exploitons {s} et voulons être en ligne',
    "page d'atterrissage pour {s}",
    "mon activité, c'est {s}",
    'construisez-moi un site pour {s}',
    'notre société fait {s}',
    '{s} - voilà ce que nous faisons, et il nous faut une présence web',
  ],
  es: [
    '{s}',
    'necesito una web para {s}',
    'tenemos {s} y queremos estar online',
    'página de aterrizaje para {s}',
    'mi negocio es {s}',
    'constrúyeme un sitio para {s}',
    'nuestra empresa se dedica a {s}',
    '{s} - eso es lo que hacemos, y necesitamos presencia web',
  ],
  it: [
    '{s}',
    'ho bisogno di un sito per {s}',
    'gestiamo {s} e vogliamo andare online',
    'landing page per {s}',
    'la mia attività è {s}',
    'costruitemi un sito per {s}',
    'la nostra azienda si occupa di {s}',
    '{s} - è quello che facciamo, e ci serve una presenza web',
  ],
};

/* ── head 1: acceptable use ───────────────────────────────────────────── */

export const ACCEPTABLE_USE_SEEDS: Record<AcceptableUseCategory, Seeds> = {
  illegal_drugs: {
    en: [
      'selling cocaine and MDMA by courier',
      'an online shop for illegal drugs',
      'a service that delivers weed and pills to your door',
      'buying heroin anonymously with no questions asked',
      'a darknet marketplace for controlled substances',
    ],
    ro: [
      'vanzarea de cocaina si MDMA prin curier',
      'un magazin online de droguri ilegale',
      'un serviciu care livreaza iarba si pastile la domiciliu',
      'cumpararea de heroina anonim, fara intrebari',
      'o piata darknet pentru substante interzise',
    ],
    de: [
      'der Verkauf von Kokain und MDMA per Kurier',
      'ein Onlineshop für illegale Drogen',
      'ein Lieferdienst für Gras und Pillen nach Hause',
      'anonym Heroin kaufen, ohne Fragen',
      'ein Darknet-Marktplatz für verbotene Substanzen',
    ],
    fr: [
      'la vente de cocaïne et de MDMA par coursier',
      'une boutique en ligne de drogues illégales',
      'un service de livraison de cannabis et de cachets à domicile',
      "acheter de l'héroïne anonymement, sans questions",
      'un marché darknet de substances interdites',
    ],
    es: [
      'la venta de cocaína y MDMA por mensajería',
      'una tienda online de drogas ilegales',
      'un servicio que entrega hierba y pastillas a domicilio',
      'comprar heroína de forma anónima, sin preguntas',
      'un mercado darknet de sustancias prohibidas',
    ],
    it: [
      'la vendita di cocaina e MDMA tramite corriere',
      'un negozio online di droghe illegali',
      'un servizio che consegna erba e pasticche a domicilio',
      'comprare eroina in modo anonimo, senza domande',
      'un mercato darknet di sostanze vietate',
    ],
  },
  prostitution_escort: {
    en: [
      'an escort agency booking paid companions',
      'a directory of sex workers available tonight',
      'arranging paid sexual services with clients',
      'a brothel with online booking',
      'hiring call girls by the hour',
    ],
    ro: [
      'o agentie de escorte care rezerva insotitoare platite',
      'un director de lucratoare sexuale disponibile in seara asta',
      'aranjarea de servicii sexuale platite cu clientii',
      'un bordel cu rezervare online',
      'angajarea de fete de companie cu ora',
    ],
    de: [
      'eine Escort-Agentur, die bezahlte Begleitung vermittelt',
      'ein Verzeichnis von Sexarbeiterinnen für heute Abend',
      'die Vermittlung bezahlter sexueller Dienstleistungen',
      'ein Bordell mit Online-Buchung',
      'Callgirls stundenweise buchen',
    ],
    fr: [
      "une agence d'escortes qui réserve des accompagnatrices payantes",
      'un annuaire de travailleuses du sexe disponibles ce soir',
      "l'organisation de services sexuels payants avec des clients",
      'une maison close avec réservation en ligne',
      'louer des call-girls à l’heure',
    ],
    es: [
      'una agencia de escorts que reserva acompañantes de pago',
      'un directorio de trabajadoras sexuales disponibles esta noche',
      'la organización de servicios sexuales de pago con clientes',
      'un burdel con reserva online',
      'contratar señoritas de compañía por horas',
    ],
    it: [
      "un'agenzia di escort che prenota accompagnatrici a pagamento",
      'un elenco di lavoratrici del sesso disponibili stasera',
      "l'organizzazione di servizi sessuali a pagamento con clienti",
      'un bordello con prenotazione online',
      'ingaggiare ragazze squillo a ore',
    ],
  },
  adult_content: {
    en: [
      'a paid porn streaming site',
      'selling explicit nude content by subscription',
      'an adult webcam platform with private shows',
      'promoting an OnlyFans page full of explicit videos',
      'a hardcore video tube site',
    ],
    ro: [
      'un site cu streaming porno cu plata',
      'vanzarea de continut explicit nud pe baza de abonament',
      'o platforma de webcam pentru adulti cu spectacole private',
      'promovarea unei pagini OnlyFans plina de filme explicite',
      'un site tube cu filme hardcore',
    ],
    de: [
      'eine kostenpflichtige Porno-Streamingseite',
      'der Verkauf expliziter Nacktinhalte im Abo',
      'eine Erwachsenen-Webcamplattform mit Privatshows',
      'die Bewerbung einer OnlyFans-Seite voller expliziter Videos',
      'eine Hardcore-Videotube',
    ],
    fr: [
      'un site de streaming porno payant',
      'la vente de contenu explicite dénudé par abonnement',
      'une plateforme de webcam pour adultes avec shows privés',
      "la promotion d'une page OnlyFans pleine de vidéos explicites",
      'un site de vidéos hardcore',
    ],
    es: [
      'un sitio de streaming porno de pago',
      'la venta de contenido explícito desnudo por suscripción',
      'una plataforma de webcam para adultos con shows privados',
      'la promoción de una página de OnlyFans llena de vídeos explícitos',
      'un tube de vídeos hardcore',
    ],
    it: [
      'un sito di streaming porno a pagamento',
      'la vendita di contenuti espliciti di nudo in abbonamento',
      'una piattaforma di webcam per adulti con show privati',
      'la promozione di una pagina OnlyFans piena di video espliciti',
      'un tube di video hardcore',
    ],
  },
  weapons_ammunition: {
    en: [
      'an online shop selling handguns and rifles',
      'selling ammunition and magazines by mail order',
      'a store for assault rifles and silencers',
      'selling untraceable gun kits with no paperwork',
      'an arms dealer taking orders online',
    ],
    ro: [
      'un magazin online care vinde pistoale si pusti',
      'vanzarea de munitie si incarcatoare prin posta',
      'un magazin de pusti de asalt si amortizoare',
      'vanzarea de kituri de arme neinregistrabile, fara acte',
      'un traficant de arme care ia comenzi online',
    ],
    de: [
      'ein Onlineshop für Pistolen und Gewehre',
      'der Versandverkauf von Munition und Magazinen',
      'ein Laden für Sturmgewehre und Schalldämpfer',
      'der Verkauf von Waffenbausätzen ohne Papiere',
      'ein Waffenhändler, der Bestellungen online annimmt',
    ],
    fr: [
      'une boutique en ligne vendant pistolets et fusils',
      'la vente de munitions et de chargeurs par correspondance',
      "un magasin de fusils d'assaut et de silencieux",
      "la vente de kits d'armes intraçables sans papiers",
      "un marchand d'armes qui prend commande en ligne",
    ],
    es: [
      'una tienda online que vende pistolas y rifles',
      'la venta de munición y cargadores por correo',
      'una tienda de fusiles de asalto y silenciadores',
      'la venta de kits de armas indetectables sin papeles',
      'un traficante de armas que toma pedidos online',
    ],
    it: [
      'un negozio online che vende pistole e fucili',
      'la vendita di munizioni e caricatori per corrispondenza',
      "un negozio di fucili d'assalto e silenziatori",
      'la vendita di kit per armi non tracciabili senza documenti',
      'un commerciante di armi che prende ordini online',
    ],
  },
  unlicensed_gambling: {
    en: [
      'an online casino with no gambling licence',
      'a sports betting site run without a licence',
      'a slots and roulette site taking crypto deposits',
      'an unlicensed poker room played for real money',
      'a lottery scheme run from abroad without authorisation',
    ],
    ro: [
      'un cazinou online fara licenta de jocuri de noroc',
      'un site de pariuri sportive operat fara licenta',
      'un site de sloturi si ruleta care accepta depuneri in cripto',
      'o camera de poker nelicentiata jucata pe bani reali',
      'o loterie administrata din strainatate fara autorizatie',
    ],
    de: [
      'ein Online-Casino ohne Glücksspiellizenz',
      'eine Sportwettenseite ohne Lizenz',
      'eine Slot- und Roulette-Seite mit Krypto-Einzahlungen',
      'ein nicht lizenzierter Pokerraum um echtes Geld',
      'eine Lotterie aus dem Ausland ohne Genehmigung',
    ],
    fr: [
      'un casino en ligne sans licence de jeu',
      'un site de paris sportifs exploité sans licence',
      'un site de machines à sous et de roulette acceptant la crypto',
      'une salle de poker non agréée jouée en argent réel',
      "une loterie gérée depuis l'étranger sans autorisation",
    ],
    es: [
      'un casino online sin licencia de juego',
      'una casa de apuestas deportivas operada sin licencia',
      'un sitio de tragaperras y ruleta que acepta cripto',
      'una sala de póker sin licencia jugada con dinero real',
      'una lotería gestionada desde el extranjero sin autorización',
    ],
    it: [
      'un casinò online senza licenza di gioco',
      'un sito di scommesse sportive gestito senza licenza',
      'un sito di slot e roulette che accetta cripto',
      'una poker room non autorizzata giocata con soldi veri',
      "una lotteria gestita dall'estero senza autorizzazione",
    ],
  },
  counterfeit_goods: {
    en: [
      'selling replica designer handbags as originals',
      'a shop for fake Rolex watches',
      'counterfeit sneakers shipped from overseas',
      'selling pirated software licence keys',
      'knock-off branded clothing at a fraction of the price',
    ],
    ro: [
      'vanzarea de genti de designer replica drept originale',
      'un magazin de ceasuri Rolex false',
      'adidasi contrafacuti expediati din strainatate',
      'vanzarea de chei de licenta software piratate',
      'haine de firma contrafacute la o fractiune din pret',
    ],
    de: [
      'der Verkauf von Designer-Taschen-Repliken als Originale',
      'ein Shop für gefälschte Rolex-Uhren',
      'gefälschte Sneaker aus Übersee',
      'der Verkauf raubkopierter Software-Lizenzschlüssel',
      'Markenkleidung als Fälschung zum Bruchteil des Preises',
    ],
    fr: [
      'la vente de sacs de créateur répliques comme des originaux',
      'une boutique de fausses montres Rolex',
      "des baskets contrefaites expédiées de l'étranger",
      'la vente de clés de licence logicielle piratées',
      'des vêtements de marque contrefaits à prix cassé',
    ],
    es: [
      'la venta de bolsos de diseño réplica como originales',
      'una tienda de relojes Rolex falsos',
      'zapatillas falsificadas enviadas desde el extranjero',
      'la venta de claves de licencia de software pirateadas',
      'ropa de marca falsificada a una fracción del precio',
    ],
    it: [
      'la vendita di borse firmate replica spacciate per originali',
      'un negozio di orologi Rolex falsi',
      "sneaker contraffatte spedite dall'estero",
      'la vendita di chiavi di licenza software piratate',
      'abbigliamento di marca contraffatto a poco prezzo',
    ],
  },
  hate_harassment: {
    en: [
      'a forum for white nationalist organising',
      'a site that mocks and publishes a named person’s home address',
      'content calling for violence against immigrants',
      'a campaign to harass a journalist until she quits',
      'a page dedicated to hatred of a religious group',
    ],
    ro: [
      'un forum pentru organizare nationalista alba',
      'un site care batjocoreste si publica adresa unei persoane',
      'continut care cheama la violenta impotriva imigrantilor',
      'o campanie de hartuire a unei jurnaliste pana renunta',
      'o pagina dedicata urii fata de un grup religios',
    ],
    de: [
      'ein Forum für weiß-nationalistische Organisation',
      'eine Seite, die eine benannte Person verhöhnt und ihre Adresse veröffentlicht',
      'Inhalte, die zu Gewalt gegen Einwanderer aufrufen',
      'eine Kampagne, um eine Journalistin bis zur Aufgabe zu belästigen',
      'eine Seite, die sich dem Hass auf eine Religionsgruppe widmet',
    ],
    fr: [
      "un forum d'organisation nationaliste blanche",
      "un site qui ridiculise et publie l'adresse d'une personne nommée",
      'des contenus appelant à la violence contre les immigrés',
      "une campagne pour harceler une journaliste jusqu'à ce qu'elle démissionne",
      "une page consacrée à la haine d'un groupe religieux",
    ],
    es: [
      'un foro de organización nacionalista blanca',
      'un sitio que se burla y publica la dirección de una persona',
      'contenido que llama a la violencia contra los inmigrantes',
      'una campaña para acosar a una periodista hasta que renuncie',
      'una página dedicada al odio a un grupo religioso',
    ],
    it: [
      "un forum per l'organizzazione nazionalista bianca",
      "un sito che deride e pubblica l'indirizzo di una persona",
      'contenuti che incitano alla violenza contro gli immigrati',
      'una campagna per molestare una giornalista fino alle dimissioni',
      'una pagina dedicata all’odio verso un gruppo religioso',
    ],
  },
  scams_impersonation: {
    en: [
      'a fake bank login page to collect customer passwords',
      'a crypto investment promising guaranteed 300% returns',
      'a site impersonating the government tax office',
      'an advance-fee scheme asking for a wire transfer first',
      'a cloned shop that takes payment and ships nothing',
    ],
    ro: [
      'o pagina falsa de logare la banca pentru a colecta parole',
      'o investitie cripto care promite randamente garantate de 300%',
      'un site care se da drept administratia fiscala',
      'o schema cu taxa in avans care cere intai un transfer bancar',
      'un magazin clonat care ia banii si nu livreaza nimic',
    ],
    de: [
      'eine gefälschte Bank-Loginseite zum Abgreifen von Passwörtern',
      'eine Krypto-Anlage mit garantierten 300 % Rendite',
      'eine Seite, die sich als Finanzamt ausgibt',
      'ein Vorschussbetrug, der zuerst eine Überweisung verlangt',
      'ein geklonter Shop, der kassiert und nichts liefert',
    ],
    fr: [
      'une fausse page de connexion bancaire pour récolter des mots de passe',
      'un placement crypto promettant 300 % de rendement garanti',
      "un site se faisant passer pour l'administration fiscale",
      "une arnaque à l'avance de frais exigeant d'abord un virement",
      "une boutique clonée qui encaisse et n'expédie rien",
    ],
    es: [
      'una página falsa de acceso bancario para recoger contraseñas',
      'una inversión cripto que promete un 300 % garantizado',
      'un sitio que suplanta a la agencia tributaria',
      'una estafa de pago por adelantado que pide primero una transferencia',
      'una tienda clonada que cobra y no envía nada',
    ],
    it: [
      'una finta pagina di accesso bancario per raccogliere password',
      'un investimento in cripto che promette il 300 % garantito',
      "un sito che si spaccia per l'agenzia delle entrate",
      'una truffa con anticipo che chiede prima un bonifico',
      'un negozio clonato che incassa e non spedisce nulla',
    ],
  },
  unlicensed_medical_financial_claims: {
    en: [
      'a supplement that cures cancer without a doctor',
      'a clinic promising to reverse diabetes in two weeks',
      'a trading signal service guaranteeing profit every month',
      'a herbal remedy advertised as a replacement for chemotherapy',
      'an unlicensed adviser selling a get-rich investment plan',
    ],
    ro: [
      'un supliment care vindeca cancerul fara medic',
      'o clinica ce promite inversarea diabetului in doua saptamani',
      'un serviciu de semnale de tranzactionare cu profit garantat lunar',
      'un remediu din plante promovat ca inlocuitor al chimioterapiei',
      'un consultant nelicentiat care vinde un plan de imbogatire',
    ],
    de: [
      'ein Nahrungsergänzungsmittel, das Krebs ohne Arzt heilt',
      'eine Klinik, die verspricht, Diabetes in zwei Wochen umzukehren',
      'ein Trading-Signaldienst mit garantiertem Monatsgewinn',
      'ein Kräutermittel, beworben als Ersatz für die Chemotherapie',
      'ein nicht zugelassener Berater mit einem Reich-werden-Plan',
    ],
    fr: [
      'un complément qui guérit le cancer sans médecin',
      "une clinique promettant d'inverser le diabète en deux semaines",
      'un service de signaux de trading garantissant un profit mensuel',
      'un remède à base de plantes présenté comme remplaçant la chimiothérapie',
      'un conseiller non agréé vendant un plan pour devenir riche',
    ],
    es: [
      'un suplemento que cura el cáncer sin médico',
      'una clínica que promete revertir la diabetes en dos semanas',
      'un servicio de señales de trading con beneficio mensual garantizado',
      'un remedio herbal anunciado como sustituto de la quimioterapia',
      'un asesor sin licencia que vende un plan para hacerse rico',
    ],
    it: [
      'un integratore che cura il cancro senza medico',
      'una clinica che promette di invertire il diabete in due settimane',
      'un servizio di segnali di trading con profitto mensile garantito',
      'un rimedio erboristico pubblicizzato come sostituto della chemioterapia',
      'un consulente non autorizzato che vende un piano per arricchirsi',
    ],
  },

  licensed_pharmacy: {
    en: [
      'a licensed community pharmacy with prescription collection',
      'a registered online pharmacy regulated by the health authority',
      'a pharmacy chain with a repeat prescription service',
      "a chemist's shop dispensing prescription medicine",
      'a pharmacy that displays its licence number and dispenses prescription medicine under pharmacist supervision',
    ],
    ro: [
      'o farmacie comunitara autorizata cu ridicare de retete',
      'o farmacie online inregistrata, reglementata de autoritatea sanitara',
      'un lant de farmacii cu serviciu de retete repetate',
      'o farmacie care elibereaza medicamente pe baza de reteta',
      'o farmacie care isi afiseaza numarul de licenta si elibereaza medicamente pe reteta sub supravegherea farmacistului',
    ],
    de: [
      'eine zugelassene Apotheke mit Rezeptabholung',
      'eine registrierte Online-Apotheke unter Aufsicht der Gesundheitsbehörde',
      'eine Apothekenkette mit Dauerrezept-Service',
      'eine Apotheke, die verschreibungspflichtige Arzneimittel abgibt',
      'eine Apotheke, die ihre Betriebserlaubnis anzeigt und verschreibungspflichtige Medikamente unter Aufsicht des Apothekers abgibt',
    ],
    fr: [
      "une pharmacie d'officine agréée avec retrait d'ordonnance",
      "une pharmacie en ligne enregistrée et contrôlée par l'autorité de santé",
      "une chaîne de pharmacies avec service d'ordonnances renouvelables",
      'une pharmacie qui délivre des médicaments sur ordonnance',
      'une pharmacie qui affiche son numéro de licence et délivre des médicaments sur ordonnance sous la supervision du pharmacien',
    ],
    es: [
      'una farmacia comunitaria autorizada con recogida de recetas',
      'una farmacia online registrada y regulada por la autoridad sanitaria',
      'una cadena de farmacias con servicio de recetas de repetición',
      'una farmacia que dispensa medicamentos con receta',
      'una farmacia que muestra su número de licencia y dispensa medicamentos con receta bajo la supervisión del farmacéutico',
    ],
    it: [
      'una farmacia autorizzata con ritiro delle ricette',
      "una farmacia online registrata e vigilata dall'autorità sanitaria",
      'una catena di farmacie con servizio di ricette ripetibili',
      'una farmacia che dispensa farmaci su prescrizione',
      'una farmacia che espone il proprio numero di licenza e dispensa farmaci su prescrizione sotto la supervisione del farmacista',
    ],
  },
  legal_cannabis: {
    en: [
      'a licensed cannabis dispensary in a state where it is legal',
      'a regulated CBD and hemp shop',
      'a legal cannabis brand with a state licence number',
      'a medical marijuana dispensary for card holders',
    ],
    ro: [
      'un dispensar de canabis autorizat intr-un stat unde este legal',
      'un magazin reglementat de CBD si canepa',
      'un brand de canabis legal cu numar de licenta',
      'un dispensar de marijuana medicinala pentru pacienti cu card',
    ],
    de: [
      'eine lizenzierte Cannabis-Abgabestelle in einem legalen Bundesstaat',
      'ein regulierter CBD- und Hanfshop',
      'eine legale Cannabismarke mit staatlicher Lizenznummer',
      'eine Abgabestelle für medizinisches Cannabis für Karteninhaber',
    ],
    fr: [
      "un dispensaire de cannabis agréé dans un État où c'est légal",
      'une boutique de CBD et de chanvre réglementée',
      'une marque de cannabis légale avec numéro de licence',
      'un dispensaire de cannabis médical pour porteurs de carte',
    ],
    es: [
      'un dispensario de cannabis con licencia en un estado donde es legal',
      'una tienda regulada de CBD y cáñamo',
      'una marca de cannabis legal con número de licencia estatal',
      'un dispensario de marihuana medicinal para titulares de tarjeta',
    ],
    it: [
      'un dispensario di cannabis autorizzato in uno stato dove è legale',
      'un negozio regolamentato di CBD e canapa',
      'un marchio di cannabis legale con numero di licenza',
      'un dispensario di cannabis medica per titolari di tessera',
    ],
  },
  firearms_training: {
    en: [
      'a certified firearms safety course and shooting range',
      'a licensed hunting school teaching rifle handling',
      'a concealed carry permit training provider',
      'a sport shooting club with instructor-led lessons',
    ],
    ro: [
      'un curs certificat de siguranta a armelor si un poligon de tragere',
      'o scoala de vanatoare autorizata care preda manuirea pustii',
      'un furnizor de instruire pentru permis de port-arma',
      'un club de tir sportiv cu lectii conduse de instructor',
    ],
    de: [
      'ein zertifizierter Waffensicherheitskurs mit Schießstand',
      'eine lizenzierte Jagdschule für Gewehrhandhabung',
      'ein Anbieter für Waffenschein-Schulungen',
      'ein Sportschützenverein mit Trainerstunden',
    ],
    fr: [
      'un cours certifié de sécurité des armes à feu avec stand de tir',
      'une école de chasse agréée enseignant le maniement du fusil',
      "un organisme de formation au port d'arme",
      'un club de tir sportif avec cours encadrés',
    ],
    es: [
      'un curso certificado de seguridad con armas y galería de tiro',
      'una escuela de caza autorizada que enseña el manejo del rifle',
      'un proveedor de formación para el permiso de armas',
      'un club de tiro deportivo con clases dirigidas',
    ],
    it: [
      'un corso certificato di sicurezza con le armi e un poligono di tiro',
      "una scuola di caccia autorizzata che insegna l'uso del fucile",
      "un ente di formazione per il porto d'armi",
      'un club di tiro sportivo con lezioni con istruttore',
    ],
  },
  sexual_health: {
    en: [
      'an STI testing clinic with confidential results',
      'a sexual health charity offering contraception advice',
      'a fertility and sexual wellbeing practice',
      'a sex education service for teenagers and parents',
    ],
    ro: [
      'o clinica de testare ITS cu rezultate confidentiale',
      'o organizatie de sanatate sexuala care ofera consiliere contraceptiva',
      'un cabinet de fertilitate si sanatate sexuala',
      'un serviciu de educatie sexuala pentru adolescenti si parinti',
    ],
    de: [
      'eine STI-Testklinik mit vertraulichen Ergebnissen',
      'ein Verein für sexuelle Gesundheit mit Verhütungsberatung',
      'eine Praxis für Fruchtbarkeit und sexuelles Wohlbefinden',
      'ein Sexualaufklärungsangebot für Jugendliche und Eltern',
    ],
    fr: [
      'une clinique de dépistage des IST aux résultats confidentiels',
      'une association de santé sexuelle offrant des conseils en contraception',
      'un cabinet de fertilité et de bien-être sexuel',
      "un service d'éducation sexuelle pour adolescents et parents",
    ],
    es: [
      'una clínica de pruebas de ITS con resultados confidenciales',
      'una asociación de salud sexual que ofrece consejo anticonceptivo',
      'una consulta de fertilidad y bienestar sexual',
      'un servicio de educación sexual para adolescentes y padres',
    ],
    it: [
      'una clinica per test IST con risultati riservati',
      "un'associazione di salute sessuale che offre consulenza contraccettiva",
      'uno studio di fertilità e benessere sessuale',
      'un servizio di educazione sessuale per adolescenti e genitori',
    ],
  },
  licensed_betting: {
    en: [
      'a licensed bookmaker regulated by the gambling commission',
      'a national lottery retailer with an official licence',
      'a betting shop holding a local authority permit',
      'a licensed online sportsbook with responsible gambling tools',
    ],
    ro: [
      'o casa de pariuri licentiata de comisia de jocuri de noroc',
      'un vanzator al loteriei nationale cu licenta oficiala',
      'o agentie de pariuri cu autorizatie de la primarie',
      'un sportsbook online licentiat cu instrumente de joc responsabil',
    ],
    de: [
      'ein lizenzierter Buchmacher unter Aufsicht der Glücksspielbehörde',
      'eine Lotterieannahmestelle mit offizieller Lizenz',
      'ein Wettbüro mit kommunaler Genehmigung',
      'ein lizenzierter Online-Sportwettenanbieter mit Spielerschutz',
    ],
    fr: [
      "un bookmaker agréé par l'autorité des jeux",
      'un détaillant de la loterie nationale avec licence officielle',
      "une agence de paris titulaire d'un permis municipal",
      'un opérateur de paris sportifs agréé avec outils de jeu responsable',
    ],
    es: [
      'una casa de apuestas autorizada por la comisión del juego',
      'un punto de venta de la lotería nacional con licencia oficial',
      'un local de apuestas con permiso municipal',
      'una casa de apuestas online autorizada con juego responsable',
    ],
    it: [
      "un bookmaker autorizzato dall'autorità dei giochi",
      'una ricevitoria del lotto con licenza ufficiale',
      "un'agenzia di scommesse con autorizzazione comunale",
      'uno sportsbook online autorizzato con strumenti di gioco responsabile',
    ],
  },
  adult_adjacent_retail: {
    en: [
      'an age-restricted lingerie and intimacy boutique',
      'a tasteful adult toy shop for couples over 18',
      'a burlesque club with ticketed evening shows',
      'a swimwear and lingerie brand with an age gate',
    ],
    ro: [
      'un butic de lenjerie intima cu restrictie de varsta',
      'un magazin discret de jucarii pentru adulti, doar peste 18 ani',
      'un club de burlesc cu spectacole de seara cu bilet',
      'un brand de costume de baie si lenjerie cu verificare a varstei',
    ],
    de: [
      'eine altersbeschränkte Dessous- und Intimboutique',
      'ein geschmackvoller Erwachsenen-Spielzeugladen für Paare ab 18',
      'ein Burlesque-Club mit ticketpflichtigen Abendshows',
      'eine Bademoden- und Dessousmarke mit Altersprüfung',
    ],
    fr: [
      "une boutique de lingerie et d'intimité réservée aux majeurs",
      'un magasin de jouets pour adultes de bon goût pour couples de plus de 18 ans',
      'un club de burlesque avec spectacles payants en soirée',
      "une marque de maillots et de lingerie avec contrôle de l'âge",
    ],
    es: [
      'una boutique de lencería e intimidad con restricción de edad',
      'una tienda discreta de juguetes para adultos para mayores de 18',
      'un club de burlesque con espectáculos nocturnos con entrada',
      'una marca de bañadores y lencería con verificación de edad',
    ],
    it: [
      'una boutique di lingerie e intimità vietata ai minori',
      'un negozio discreto di giocattoli per adulti per coppie over 18',
      'un club di burlesque con spettacoli serali a biglietto',
      "un marchio di costumi e lingerie con verifica dell'età",
    ],
  },

  /**
   * `clean` carries the most seeds by a distance, for two reasons that are
   * not about fairness.
   *
   * One: it is the overwhelming majority class in production. A taxonomy with
   * forty-five prohibited seeds and eight clean ones has a geometry that
   * leans toward refusing, and refusing a real customer is the worst thing
   * this classifier can do.
   *
   * Two, and more interesting: the last four seeds in each language are
   * ADJACENT businesses — a model railway shop that sells reproductions, a
   * tackle shop that sells outdoor gear, an arcade with prize tickets, a
   * nutritionist who gives food advice. Each sits near a prohibited centroid
   * in surface vocabulary and nowhere near it in meaning, and without them
   * the nearest thing to "scale reproductions of famous locomotives" in this
   * space is the counterfeit centroid. Teaching the geometry where the line
   * is, is the classifier-shaped way to fix that; a keyword exception would
   * be the other way, and we do not do that here.
   */
  clean: {
    en: [
      'a dental clinic taking new patients',
      'a speciality coffee roaster with a small online shop',
      "a wedding photographer's portfolio",
      'a family-run Italian restaurant',
      'an accountancy practice for small businesses',
      'a yoga studio with a class timetable',
      'a plumber covering the local area',
      "a landscape architect's project portfolio",
      'a bicycle repair workshop with spare parts',
      'a veterinary surgery for cats and dogs',
      'an independent bookshop with a reading room and events',
      'a language school with evening classes',
      'a model railway shop selling scale reproductions of famous locomotives',
      'a fishing tackle shop selling rods, reels and bait',
      'an amusement arcade with pinball machines and prize tickets',
      'a nutritionist who plans everyday meals and makes no medical claims',
      'a licensed dermatology clinic offering laser tattoo removal and skin cancer screening',
      "a registered dermatologist's practice for mole checks and skin cancer screening",
      'a physiotherapy clinic for sports injuries and post-surgery rehabilitation',
      'a cosmetic clinic run by licensed practitioners offering Botox and dermal fillers',
      "an optician's practice offering eye tests and glasses fittings",
    ],
    ro: [
      'o clinica dentara care primeste pacienti noi',
      'o prajitorie de cafea de specialitate cu un mic magazin online',
      'portofoliul unui fotograf de nunta',
      'un restaurant italian de familie',
      'un cabinet de contabilitate pentru firme mici',
      'un studio de yoga cu orarul cursurilor',
      'un instalator care acopera zona locala',
      'portofoliul de proiecte al unui arhitect peisagist',
      'un atelier de reparatii biciclete cu piese de schimb',
      'un cabinet veterinar pentru pisici si caini',
      'o librarie independenta cu sala de lectura si evenimente',
      'o scoala de limbi straine cu cursuri de seara',
      'un magazin de modelism care vinde reproduceri la scara ale locomotivelor celebre',
      'un magazin de pescuit care vinde undite, mulinete si momeala',
      'o sala de jocuri cu aparate de pinball si bilete de premiu',
      'un nutritionist care planifica mese zilnice si nu face afirmatii medicale',
      'o clinica de dermatologie autorizata care ofera indepartarea tatuajelor cu laser si screening pentru cancerul de piele',
      'cabinetul unui dermatolog inregistrat pentru verificarea alunitelor si screening pentru cancerul de piele',
      'o clinica de fizioterapie pentru accidentari sportive si recuperare dupa operatie',
      'o clinica de cosmetica condusa de practicieni licentiati care ofera botox si filler dermic',
      'cabinetul unui optician care ofera control de vedere si montare de ochelari',
    ],
    de: [
      'eine Zahnarztpraxis, die neue Patienten aufnimmt',
      'eine Spezialitätenrösterei mit kleinem Onlineshop',
      'das Portfolio eines Hochzeitsfotografen',
      'ein familiengeführtes italienisches Restaurant',
      'eine Steuerkanzlei für kleine Unternehmen',
      'ein Yogastudio mit Kursplan',
      'ein Installateur für die Umgebung',
      'das Projektportfolio einer Landschaftsarchitektin',
      'eine Fahrradwerkstatt mit Ersatzteilen',
      'eine Tierarztpraxis für Katzen und Hunde',
      'eine unabhängige Buchhandlung mit Lesesaal und Veranstaltungen',
      'eine Sprachschule mit Abendkursen',
      'ein Modellbahnladen mit maßstabsgetreuen Nachbildungen berühmter Lokomotiven',
      'ein Angelladen mit Ruten, Rollen und Ködern',
      'eine Spielhalle mit Flipperautomaten und Gewinntickets',
      'eine Ernährungsberaterin, die Alltagsmahlzeiten plant und keine Heilversprechen macht',
      'eine zugelassene dermatologische Klinik mit Laser-Tattooentfernung und Hautkrebs-Screening',
      'die Praxis eines registrierten Dermatologen für Muttermalkontrollen und Hautkrebs-Screening',
      'eine Physiotherapiepraxis für Sportverletzungen und Reha nach Operationen',
      'eine von zugelassenen Fachkräften geführte Kosmetikklinik mit Botox und Fillern',
      'eine Optikerpraxis mit Sehtests und Brillenanpassung',
    ],
    fr: [
      'un cabinet dentaire qui accepte de nouveaux patients',
      'un torréfacteur de café de spécialité avec une petite boutique en ligne',
      "le portfolio d'un photographe de mariage",
      'un restaurant italien familial',
      'un cabinet comptable pour petites entreprises',
      'un studio de yoga avec planning des cours',
      'un plombier qui couvre le secteur',
      "le portfolio de projets d'une paysagiste",
      'un atelier de réparation de vélos avec pièces détachées',
      'un cabinet vétérinaire pour chats et chiens',
      'une librairie indépendante avec salle de lecture et rencontres',
      "une école de langues avec des cours du soir",
      'une boutique de modélisme vendant des reproductions à échelle de locomotives célèbres',
      'un magasin de pêche vendant cannes, moulinets et appâts',
      'une salle de jeux avec flippers et tickets de gain',
      'une nutritionniste qui planifie les repas du quotidien sans promesse médicale',
      "une clinique de dermatologie agréée proposant l'élimination des tatouages au laser et le dépistage du cancer de la peau",
      "le cabinet d'un dermatologue enregistré pour le contrôle des grains de beauté et le dépistage du cancer de la peau",
      'une clinique de kinésithérapie pour les blessures sportives et la rééducation post-opératoire',
      'une clinique esthétique dirigée par des praticiens agréés proposant botox et acide hyaluronique',
      "le cabinet d'un opticien proposant des examens de la vue et l'ajustement de lunettes",
    ],
    es: [
      'una clínica dental que admite nuevos pacientes',
      'un tostador de café de especialidad con una pequeña tienda online',
      'el portafolio de un fotógrafo de bodas',
      'un restaurante italiano familiar',
      'una asesoría contable para pequeñas empresas',
      'un estudio de yoga con horario de clases',
      'un fontanero que cubre la zona',
      'el portafolio de proyectos de una paisajista',
      'un taller de reparación de bicicletas con repuestos',
      'una clínica veterinaria para gatos y perros',
      'una librería independiente con sala de lectura y encuentros',
      'una escuela de idiomas con clases nocturnas',
      'una tienda de modelismo que vende reproducciones a escala de locomotoras famosas',
      'una tienda de pesca que vende cañas, carretes y cebo',
      'un salón recreativo con máquinas de pinball y tickets de premio',
      'una nutricionista que planifica comidas diarias y no hace promesas médicas',
      'una clínica de dermatología autorizada que ofrece eliminación de tatuajes con láser y detección de cáncer de piel',
      'la consulta de un dermatólogo registrado para revisión de lunares y detección de cáncer de piel',
      'una clínica de fisioterapia para lesiones deportivas y rehabilitación postoperatoria',
      'una clínica estética dirigida por profesionales autorizados que ofrece botox y rellenos dérmicos',
      'la consulta de un óptico que ofrece exámenes de la vista y ajuste de gafas',
    ],
    it: [
      'uno studio dentistico che accetta nuovi pazienti',
      'una torrefazione di caffè speciality con un piccolo negozio online',
      'il portfolio di un fotografo di matrimoni',
      'un ristorante italiano a conduzione familiare',
      'uno studio commercialista per piccole imprese',
      'uno studio di yoga con orario dei corsi',
      'un idraulico che copre la zona',
      'il portfolio di progetti di un paesaggista',
      "un'officina di riparazione biciclette con ricambi",
      'un ambulatorio veterinario per gatti e cani',
      'una libreria indipendente con sala lettura e incontri',
      'una scuola di lingue con corsi serali',
      'un negozio di modellismo che vende riproduzioni in scala di locomotive famose',
      'un negozio di pesca che vende canne, mulinelli ed esche',
      'una sala giochi con flipper e biglietti premio',
      'una nutrizionista che pianifica i pasti quotidiani senza promesse mediche',
      'una clinica dermatologica autorizzata che offre rimozione di tatuaggi al laser e screening per il cancro della pelle',
      'lo studio di un dermatologo registrato per il controllo dei nei e lo screening del cancro della pelle',
      'una clinica di fisioterapia per infortuni sportivi e riabilitazione post-operatoria',
      'una clinica estetica gestita da professionisti autorizzati che offre botox e filler dermici',
      "lo studio di un ottico che offre esami della vista e montaggio di occhiali",
    ],
  },
};

/* ── head 2: commercial scope ─────────────────────────────────────────── */

export const SCOPE_SEEDS: Record<ScopeCategory, Seeds> = {
  'standard-site': {
    en: [
      'a brochure site for a local business',
      'a portfolio for a freelance designer',
      'a services page for a physiotherapy practice',
      'a restaurant site with the menu and opening hours',
      'a one-page site for a life coach with a contact form',
      'a small shop with a simple catalogue of twelve products',
      'a clinic site with a widget to book an intro call',
      'an about page and a gallery for a barber shop',
      'an estate agent with property listings and viewing enquiries',
      'a dance school with class descriptions and term dates',
      'a wedding venue with photos, packages and an enquiry form',
      'a gardening service with before and after photos and a quote form',
      'a tutoring service listing subjects, prices and a contact form',
      'a driving instructor with lesson prices and a booking enquiry',
    ],
    ro: [
      'un site de prezentare pentru o afacere locala',
      'un portofoliu pentru un designer freelancer',
      'o pagina de servicii pentru un cabinet de fizioterapie',
      'un site de restaurant cu meniul si programul',
      'un site de o pagina pentru un life coach, cu formular de contact',
      'un magazin mic cu un catalog simplu de douasprezece produse',
      'un site de clinica cu widget pentru programarea unei discutii initiale',
      'o pagina despre noi si o galerie pentru o frizerie',
      'o agentie imobiliara cu anunturi si solicitari de vizionare',
      'o scoala de dans cu descrierea cursurilor si datele semestrelor',
      'o locatie pentru nunti cu poze, pachete si formular de solicitare',
      'un serviciu de gradinarit cu poze inainte si dupa si formular de oferta',
      'un serviciu de meditatii cu materii, preturi si formular de contact',
      'un instructor auto cu preturi la lectii si o cerere de programare',
    ],
    de: [
      'eine Broschürenseite für ein lokales Geschäft',
      'ein Portfolio für eine freiberufliche Designerin',
      'eine Leistungsseite für eine Physiotherapiepraxis',
      'eine Restaurantseite mit Speisekarte und Öffnungszeiten',
      'eine Onepager-Seite für einen Life-Coach mit Kontaktformular',
      'ein kleiner Shop mit einem einfachen Katalog von zwölf Produkten',
      'eine Praxisseite mit Widget für ein kostenloses Erstgespräch',
      'eine Über-uns-Seite und eine Galerie für einen Friseursalon',
      'ein Immobilienmakler mit Objektangeboten und Besichtigungsanfragen',
      'eine Tanzschule mit Kursbeschreibungen und Semesterterminen',
      'eine Hochzeitslocation mit Fotos, Paketen und Anfrageformular',
      'ein Gartenservice mit Vorher-Nachher-Fotos und Angebotsformular',
      'ein Nachhilfeangebot mit Fächern, Preisen und Kontaktformular',
      'ein Fahrlehrer mit Stundenpreisen und einer Buchungsanfrage',
    ],
    fr: [
      'un site vitrine pour un commerce local',
      'un portfolio pour une graphiste indépendante',
      'une page de services pour un cabinet de kinésithérapie',
      'un site de restaurant avec la carte et les horaires',
      "un site d'une page pour un coach de vie avec formulaire de contact",
      'une petite boutique avec un catalogue simple de douze produits',
      'un site de clinique avec un widget pour réserver un appel découverte',
      'une page à propos et une galerie pour un salon de coiffure',
      'une agence immobilière avec des annonces et des demandes de visite',
      'une école de danse avec descriptions des cours et dates des trimestres',
      'un lieu de réception de mariage avec photos, formules et formulaire de demande',
      'un service de jardinage avec photos avant après et formulaire de devis',
      'un service de soutien scolaire avec matières, tarifs et formulaire de contact',
      "un moniteur d'auto-école avec tarifs des leçons et une demande de réservation",
    ],
    es: [
      'un sitio de presentación para un negocio local',
      'un portafolio para una diseñadora autónoma',
      'una página de servicios para una consulta de fisioterapia',
      'un sitio de restaurante con la carta y el horario',
      'un sitio de una página para un coach de vida con formulario de contacto',
      'una tienda pequeña con un catálogo simple de doce productos',
      'un sitio de clínica con un widget para reservar una llamada inicial',
      'una página sobre nosotros y una galería para una barbería',
      'una inmobiliaria con anuncios de pisos y solicitudes de visita',
      'una escuela de baile con descripción de clases y fechas del trimestre',
      'un espacio para bodas con fotos, paquetes y formulario de consulta',
      'un servicio de jardinería con fotos de antes y después y formulario de presupuesto',
      'un servicio de clases particulares con asignaturas, precios y formulario de contacto',
      'un profesor de autoescuela con precios de clases y una solicitud de reserva',
    ],
    it: [
      "un sito vetrina per un'attività locale",
      'un portfolio per una designer freelance',
      'una pagina servizi per uno studio di fisioterapia',
      'un sito di ristorante con il menu e gli orari',
      'un sito di una pagina per un life coach con modulo di contatto',
      'un piccolo negozio con un catalogo semplice di dodici prodotti',
      'un sito di clinica con widget per prenotare una call conoscitiva',
      'una pagina chi siamo e una galleria per un barbiere',
      "un'agenzia immobiliare con annunci e richieste di visita",
      'una scuola di danza con descrizione dei corsi e date dei trimestri',
      'una location per matrimoni con foto, pacchetti e modulo di richiesta',
      'un servizio di giardinaggio con foto prima e dopo e modulo per il preventivo',
      'un servizio di ripetizioni con materie, prezzi e modulo di contatto',
      'un istruttore di guida con prezzi delle lezioni e una richiesta di prenotazione',
    ],
  },
  'custom-work': {
    en: [
      'a marketplace where buyers and sellers both have accounts',
      'a SaaS platform with subscription billing and an admin panel',
      'a mobile app with user sign-up and push notifications',
      'a customer portal that syncs with our ERP over an API',
      'a booking and payment system with staff rotas and refunds',
      'a multi-tenant dashboard for enterprise clients in four languages',
      'migrating a large legacy intranet onto a new platform',
      'a custom integration between our CRM and our warehouse system',
    ],
    ro: [
      'o piata unde si cumparatorii si vanzatorii au conturi',
      'o platforma SaaS cu facturare pe abonament si panou de administrare',
      'o aplicatie mobila cu inregistrare de utilizatori si notificari push',
      'un portal pentru clienti care se sincronizeaza cu ERP-ul nostru prin API',
      'un sistem de rezervari si plati cu ture de personal si rambursari',
      'un dashboard multi-tenant pentru clienti enterprise in patru limbi',
      'migrarea unui intranet vechi si mare pe o platforma noua',
      'o integrare personalizata intre CRM-ul nostru si sistemul de depozit',
    ],
    de: [
      'ein Marktplatz, auf dem Käufer und Verkäufer Konten haben',
      'eine SaaS-Plattform mit Abo-Abrechnung und Adminbereich',
      'eine mobile App mit Registrierung und Push-Benachrichtigungen',
      'ein Kundenportal, das sich per API mit unserem ERP abgleicht',
      'ein Buchungs- und Zahlungssystem mit Dienstplänen und Erstattungen',
      'ein mandantenfähiges Dashboard für Firmenkunden in vier Sprachen',
      'die Migration eines großen Altsystem-Intranets auf eine neue Plattform',
      'eine individuelle Integration zwischen unserem CRM und dem Lagersystem',
    ],
    fr: [
      'une place de marché où acheteurs et vendeurs ont un compte',
      "une plateforme SaaS avec facturation par abonnement et panneau d'administration",
      'une application mobile avec inscription et notifications push',
      'un portail client synchronisé avec notre ERP via une API',
      'un système de réservation et de paiement avec plannings et remboursements',
      'un tableau de bord multi-tenant pour grands comptes en quatre langues',
      "la migration d'un grand intranet hérité vers une nouvelle plateforme",
      'une intégration sur mesure entre notre CRM et notre système de gestion de stock',
    ],
    es: [
      'un marketplace donde compradores y vendedores tienen cuenta',
      'una plataforma SaaS con facturación por suscripción y panel de administración',
      'una app móvil con registro de usuarios y notificaciones push',
      'un portal de clientes que se sincroniza con nuestro ERP por API',
      'un sistema de reservas y pagos con turnos de personal y reembolsos',
      'un panel multiinquilino para clientes corporativos en cuatro idiomas',
      'migrar una gran intranet heredada a una plataforma nueva',
      'una integración a medida entre nuestro CRM y el sistema de almacén',
    ],
    it: [
      'un marketplace dove acquirenti e venditori hanno un account',
      'una piattaforma SaaS con fatturazione in abbonamento e pannello di amministrazione',
      "un'app mobile con registrazione utenti e notifiche push",
      'un portale clienti che si sincronizza con il nostro ERP via API',
      'un sistema di prenotazioni e pagamenti con turni del personale e rimborsi',
      'una dashboard multi-tenant per clienti enterprise in quattro lingue',
      'la migrazione di una grande intranet legacy su una nuova piattaforma',
      "un'integrazione su misura tra il nostro CRM e il sistema di magazzino",
    ],
  },
  unclear: {
    en: [
      'something online for my business',
      'a website, I am not sure what kind yet',
      'help me get started on the internet',
      'we need a digital presence',
      'an idea I am still thinking through',
    ],
    ro: [
      'ceva online pentru afacerea mea',
      'un site, inca nu stiu exact ce fel',
      'ajutati-ma sa incep pe internet',
      'avem nevoie de o prezenta digitala',
      'o idee la care inca ma gandesc',
    ],
    de: [
      'etwas Online für mein Geschäft',
      'eine Website, ich weiß noch nicht welche Art',
      'hilf mir, im Internet anzufangen',
      'wir brauchen eine digitale Präsenz',
      'eine Idee, über die ich noch nachdenke',
    ],
    fr: [
      'quelque chose en ligne pour mon entreprise',
      'un site web, je ne sais pas encore lequel',
      'aidez-moi à démarrer sur internet',
      "nous avons besoin d'une présence numérique",
      "une idée que je suis encore en train de mûrir",
    ],
    es: [
      'algo online para mi negocio',
      'una web, todavía no sé de qué tipo',
      'ayúdame a empezar en internet',
      'necesitamos una presencia digital',
      'una idea que todavía estoy pensando',
    ],
    it: [
      'qualcosa online per la mia attività',
      'un sito, non so ancora di che tipo',
      'aiutami a iniziare su internet',
      'abbiamo bisogno di una presenza digitale',
      "un'idea a cui sto ancora pensando",
    ],
  },
};

/* ── generation ───────────────────────────────────────────────────────── */

export type Split = 'train' | 'holdout';

function templatesFor(language: Language, split: Split): string[] {
  const all = TEMPLATES[language];
  return split === 'train' ? all.slice(0, -HOLDOUT_TEMPLATES) : all.slice(-HOLDOUT_TEMPLATES);
}

function cross(
  decision: string,
  seeds: Record<string, Seeds>,
  split: Split,
  languages: readonly Language[],
): LabelledPhrase[] {
  const out: LabelledPhrase[] = [];
  for (const [label, byLanguage] of Object.entries(seeds)) {
    for (const language of languages) {
      for (const seed of byLanguage[language]) {
        for (const template of templatesFor(language, split)) {
          out.push({ decision, label, text: template.replaceAll('{s}', seed) });
        }
      }
    }
  }
  return out;
}

/**
 * Every phrase for one split, both heads.
 *
 * `train` builds the centroids; `holdout` is what `calibrate` sweeps the band
 * on. They share seeds and differ in template, so a band chosen on the
 * holdout is a band that survives a phrasing it has not seen.
 */
export function buildPhrases(
  split: Split,
  languages: readonly Language[] = LANGUAGES,
): LabelledPhrase[] {
  return [
    ...cross(ACCEPTABLE_USE_HEAD, ACCEPTABLE_USE_SEEDS, split, languages),
    ...cross(SCOPE_HEAD, SCOPE_SEEDS, split, languages),
  ];
}

/** Per-label counts, for the provenance file. */
export function phraseCounts(phrases: readonly LabelledPhrase[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const phrase of phrases) {
    const key = `${phrase.decision}/${phrase.label}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}
