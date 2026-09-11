export const adminKeys = {
  // Sidebar — operator `/admin/dashboard` chrome (not end-user "team" app nav).
  'admin.sidebar.section.operations': 'Operations',
  'admin.sidebar.section.infrastructure': 'Infrastructure',
  'admin.sidebar.section.insights': 'Insights',
  'admin.sidebar.section.workspace': 'Team & settings',
  'admin.nav.dashboard': 'Dashboard',
  'admin.nav.projects': 'Projects',
  'admin.nav.pipeline': 'Pipeline',
  'admin.nav.accounts': 'Accounts',
  'admin.nav.leads': 'Leads',
  'admin.nav.inquiries': 'Custom inquiries',
  'admin.nav.hosting': 'Hosting',
  'admin.nav.analytics': 'Analytics',
  'admin.nav.aiUsage': 'AI usage',
  'admin.nav.teamMembers': 'Team members',
  'admin.nav.settings': 'Settings',
  'admin.mobile.theme': 'Theme',

  // Dashboard masthead
  'admin.dashboard.masthead.loading': 'Loading project overview…',
  'admin.dashboard.masthead.noProjects':
    "You don't have any projects yet, start by creating a new project",
  'admin.dashboard.masthead.projectsInFlight':
    '{count} project in flight today',
  'admin.dashboard.masthead.projectsInFlightPlural':
    '{count} projects in flight today',
  /** Shown next to the logo on /admin login & join (operator shell). */
  'admin.shell.headerBadge': 'Admin',

  'admin.dashboard.cta.newProject': 'Create new project',

  // Stats
  'admin.dashboard.stats.projects': 'Projects',
  'admin.dashboard.stats.projectsSub': '{draft} draft · {building} in build',
  'admin.dashboard.stats.live': 'Live',
  'admin.dashboard.stats.liveSubOn': 'Published sites',
  'admin.dashboard.stats.liveSubOff': 'None live yet',
  'admin.dashboard.stats.clients': 'Clients',
  'admin.dashboard.stats.clientsSub': '{count} account on file',
  'admin.dashboard.stats.clientsSubPlural': '{count} accounts on file',
  'admin.dashboard.stats.clientsSubEmpty': 'No accounts yet',
  'admin.dashboard.stats.revenue': 'Revenue',
  'admin.dashboard.stats.revenueSubArr': '{arr} ARR (run-rate)',
  'admin.dashboard.stats.revenueSubSetupOnly': '{setup} setup on projects',
  'admin.dashboard.stats.revenueSubInvoicesSingular': '{count} invoice settled',
  'admin.dashboard.stats.revenueSubInvoicesPlural': '{count} invoices settled',
  'admin.dashboard.stats.aiThisMonth': 'AI this month',
  'admin.dashboard.stats.aiThisMonthSubEmpty':
    'No editor sessions logged yet this month',
  'admin.dashboard.stats.aiThisMonthSub': '{tokens} tokens across 1 session',
  'admin.dashboard.stats.aiThisMonthSubPlural':
    '{tokens} tokens across {count} sessions',

  // Panels
  'admin.dashboard.pipeline.eyebrow': 'Pipeline',
  'admin.dashboard.pipeline.title': 'Workflow board',
  'admin.dashboard.pipeline.metaWithCount':
    '{count} project · drag cards between stages',
  'admin.dashboard.pipeline.metaWithCountPlural':
    '{count} projects · drag cards between stages',
  'admin.dashboard.pipeline.metaEmpty':
    'Drag cards between stages when you add projects',

  'admin.dashboard.recent.eyebrow': 'Projects',
  'admin.dashboard.recent.title': 'Recent activity',
  'admin.dashboard.recent.metaTotal': '{count} total',

  'admin.dashboard.viewAll': 'View all',

  'admin.dashboard.activity.eyebrow': 'Workspace',
  'admin.dashboard.activity.title': 'Projects & accounts',
  'admin.dashboard.activity.tab.projects': 'Projects',
  'admin.dashboard.activity.tab.accounts': 'Accounts',

  'admin.dashboard.accounts.eyebrow': 'Directory',
  'admin.dashboard.accounts.title': 'Accounts',
  'admin.dashboard.accounts.meta': '{count} with billing or contact on file',

  // Projects table
  'admin.dashboard.table.project': 'Project',
  'admin.dashboard.table.account': 'Account',
  'admin.dashboard.table.tier': 'Tier',
  'admin.dashboard.table.stage': 'Stage',
  'admin.dashboard.table.updated': 'Updated',
  'admin.dashboard.table.emptyAccount': '–',
  'admin.dashboard.projects.emptyTitle': 'No projects yet',
  'admin.dashboard.projects.emptyBody':
    'After you create a project, it will appear here',
  /** Team projects list masthead (`/admin/dashboard/projects`). */
  'admin.dashboard.projects.shellSubtitle':
    'All the projects we created and manage',

  // Project row actions
  'admin.dashboard.project.actions.label': 'Project actions',
  'admin.dashboard.project.actions.rename': 'Rename',
  'admin.dashboard.project.actions.delete': 'Delete',
  'admin.dashboard.project.renamePrompt': 'Rename project',
  'admin.dashboard.project.deleteConfirm':
    'Delete "{name}"? This cannot be undone',
  'admin.dashboard.project.deleteConfirmUnnamed':
    'Delete this project? This cannot be undone',
  'admin.dashboard.project.untitled': 'Untitled',

  // Stage / tier labels — keys mirror what the table maps to via STAGE_I18N_KEYS
  'admin.stage.intake': 'Intake',
  'admin.stage.brief': 'Brief',
  'admin.stage.build': 'Build',
  'admin.stage.review': 'Review',
  'admin.stage.live': 'Live',
  'admin.tier.essential': 'Essential',
  'admin.tier.pro': 'Pro',
  'admin.tier.commerce': 'Commerce',
  'admin.tier.custom': 'Custom',

  // Clients table
  'admin.dashboard.clients.col.account': 'Account',
  'admin.dashboard.clients.col.contact': 'Contact',
  'admin.dashboard.clients.col.tier': 'Tier',
  'admin.dashboard.clients.col.projects': 'Projects',
  'admin.dashboard.clients.col.setupPaid': 'Setup paid',
  'admin.dashboard.clients.col.lastActivity': 'Last activity',
  'admin.dashboard.clients.col.actions': 'Actions',
  'admin.dashboard.clients.emptyTitle': 'No accounts yet',
  'admin.dashboard.clients.emptyBody':
    'Accounts aggregate billing and contact details from projects you link to them. Add contact info when you create or edit a project',
  'admin.dashboard.clients.emailAria': 'Email {name}',
  'admin.dashboard.clients.callAria': 'Call {name}',
  'admin.dashboard.clients.unnamed': 'Unnamed client',

  'admin.dashboard.newProject.subtitle':
    'Add discovery notes, then complete client details, the project brief, and setup before creating the project',

  'admin.dashboard.newProject.discovery.title': 'Discovery notes',
  'admin.dashboard.newProject.discovery.description':
    'Paste raw notes from your discovery call. Aim for at least 2 to 3 phrases (about {minWords} words) before you continue so there is enough context for the project brief. Use Enhance with AI when you want those notes applied to the next steps',
  'admin.dashboard.newProject.discovery.notesMinLengthHint':
    'Add at least {minWords} words (2 to 3 phrases) of discovery notes',
  'admin.dashboard.newProject.discovery.notesPlaceholder':
    'Example: Spoke with Maria - runs a small dental clinic in Bucharest with two dentists, mostly word-of-mouth. She wants a clean modern site to attract younger patients and mentioned online booking. Budget around €2k. Tone friendly but professional…',
  'admin.dashboard.newProject.discovery.enhanceWithAi': 'Enhance with AI',
  'admin.dashboard.newProject.discovery.enhancing': 'Enhancing…',

  // Hosting — connect an existing (already bootstrapped) Hetzner server
  'admin.hosting.connectExisting.button': 'Connect existing server',
  'admin.hosting.connectExisting.pending': 'Connecting…',
  'admin.hosting.connectExisting.success': 'Existing server connected',
  'admin.hosting.connectExisting.error.generic':
    'Could not connect the existing server',
  'admin.hosting.connectExisting.error.configMissing':
    'Existing server is not configured on this environment',
  'admin.hosting.connectExisting.error.secretUnavailable':
    'Existing server credentials are not available',
  'admin.hosting.connectExisting.error.healthCheckFailed':
    'Could not verify the existing server is ready',
  'admin.hosting.connectExisting.error.hetznerApiFailed':
    'Could not verify the server with the hosting provider',
  'admin.hosting.connectExisting.error.serverNotReady':
    'The existing server is not running yet',
  'admin.hosting.connectExisting.error.dbError':
    'Could not save the server record',
} as const;
