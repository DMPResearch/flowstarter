import { adminKeys } from './en/admin';

// Locale catalog (en)
const en = {
  // General
  'app.name': 'Flowstarter',
  'app.title': 'Flowstarter - Premium websites for service professionals',
  'app.description':
    'We design and build your website or online store, then you change it yourself just by asking. For small businesses across Europe. From €799',
  'app.back': 'Back',
  'app.saveContinue': 'Continue',
  'app.createProject': 'Create Project',
  'app.publish': 'Publish',
  'app.cancel': 'Cancel',
  'app.apply': 'Apply',
  'app.discardDraft': 'Discard draft',
  'app.keepEditing': 'Keep editing',
  'app.loadingExperience': 'Loading your experience...',
  'app.error': 'Error',
  'app.failedToFetchIndustries': 'Failed to fetch industries. Please try again',
  'app.needHelp': 'Need help or a custom solution?',
  'app.bookCallWithUs': 'Get my custom plan',
  'app.saveFailed': 'Save failed',
  'app.saving': 'Saving…',
  'app.offline': 'Offline',
  'app.continue': 'Continue',
  'app.profile': 'Profile',
  'app.settings': 'Settings',
  'app.signOut': 'Sign out',
  'app.sigOutTitle': 'Are you sure you want to sign out?',
  'app.signOutDescription':
    'You will need to sign in again to access your dashboard',
  'app.redirectingToDashboard': 'Redirecting to dashboard...',
  'app.loading': 'Loading...',
  'app.clear': 'Clear',

  'common.and': 'and',
  'common.dismiss': 'Dismiss',
  'common.eg': 'e.g.: \u00A0',

  // Auth
  'auth.signUp.title': 'Create your account',
  'auth.signUp.subtitle':
    'Flowstarter builds your online presence and gives you the tools to run it, all in one place',
  'auth.marketing.signup.easyStart': 'Your assistant helps you start securely',
  'auth.marketing.signup.noCreditCard':
    'Enterprise-grade security protects your data',
  'auth.marketing.signup.getOnlineFast': 'Smart guidance every step of the way',
  'auth.signUp.fullName': 'Full name',
  'auth.signUp.passwordRequirements':
    'Must be {min}-{max} characters and contain numbers and letters',
  'auth.signUp.creatingAccount': 'Creating account...',
  'auth.signUp.createFreeAccount': 'Create free account',
  'auth.signUp.byContinuing':
    "By continuing, you agree & acknowledge that you've read and agree to {appName}",
  'auth.signUp.termsOfService': 'Terms of Service',
  'auth.signUp.privacyPolicy': 'Privacy Policy',
  'auth.email': 'Email address',
  'auth.password': 'Password',
  'auth.signIn.signingIn': 'Signing in...',
  'auth.signIn': 'Sign in',
  'auth.forgotPassword': 'Forgot password?',
  'auth.forgotPassword.title': 'Reset your password',
  'auth.forgotPassword.description':
    'Enter your email address and we will send you a password reset code',
  'auth.forgotPassword.sendCode': 'Send reset code',
  'auth.forgotPassword.sendingCode': 'Sending code...',
  'auth.forgotPassword.backToSignIn': 'Back to sign in',
  'auth.forgotPassword.codeSuccess': 'Password reset code sent to your email',
  'auth.forgotPassword.enterCode': 'Enter reset code',
  'auth.forgotPassword.newPassword': 'New password',
  'auth.forgotPassword.confirmPassword': 'Confirm password',
  'auth.forgotPassword.resetPassword': 'Reset password',
  'auth.forgotPassword.resettingPassword': 'Resetting...',
  'auth.forgotPassword.success': 'Password reset successful!',
  'auth.forgotPassword.passwordsDoNotMatch': 'Passwords do not match',
  'auth.forgotPassword.invalidCode': 'Invalid or expired reset code',
  'auth.forgotPassword.resendCode': 'Resend code',

  'auth.mfa.title': 'Two-factor authentication',
  'auth.mfa.totpHint': 'Enter the 6-digit code from your authenticator app',
  'auth.mfa.backupHint': 'Enter one of your backup codes',
  'auth.mfa.codeLabel': 'Verification code',
  'auth.mfa.codePlaceholder.totp': '123456',
  'auth.mfa.codePlaceholder.backup': 'Backup code',
  'auth.mfa.verify': 'Verify',
  'auth.mfa.verifying': 'Verifying…',
  'auth.mfa.useAuthenticatorApp': 'Authenticator app',
  'auth.mfa.useBackupCode': 'Backup code',
  'auth.mfa.invalidCode': 'Invalid code. Try again',
  'auth.mfa.back': 'Back',
  'auth.mfa.unsupportedFactor':
    'This account uses a second step we can’t complete here (for example a text or email code). Use an authenticator app or backup codes in Clerk, or contact an admin',

  // Client Trust: a password sign-in from a device Clerk has not seen
  // before. A first-factor step-up, not two-factor, so it gets its own
  // copy rather than borrowing the "Two-factor authentication" title.
  'auth.clientTrust.title': 'Verify this device',
  'auth.clientTrust.emailHint':
    'Enter the code we emailed you to verify this device',
  'auth.clientTrust.phoneHint':
    'Enter the code we texted you to verify this device',
  'auth.clientTrust.codeLabel': 'Verification code',
  'auth.clientTrust.codePlaceholder': '123456',
  'auth.clientTrust.verify': 'Verify',
  'auth.clientTrust.verifying': 'Verifying…',
  'auth.clientTrust.useEmail': 'Email',
  'auth.clientTrust.usePhone': 'Text message',
  'auth.clientTrust.resendCode': 'Resend code',
  'auth.clientTrust.back': 'Back',
  'auth.clientTrust.invalidCode': 'Invalid or expired code. Try again',
  'auth.clientTrust.sendFailed':
    'Could not send the verification code. Try again',
  'auth.clientTrust.unsupportedFactor':
    'This device needs to be verified before you can sign in, and we could not find a way to do that here. Contact an admin',

  'auth.email.placeholder': 'e.g johnatan@doe.com',
  'auth.password.placeholder': 'Enter your password',
  'auth.signUp.fullName.placeholder': 'e.g Johnatan Doe',
  'auth.passwordStrength': 'Password strength',
  'auth.passwordStrength.veryWeak': 'Very weak',
  'auth.passwordStrength.weak': 'Weak',
  'auth.passwordStrength.fair': 'Fair',
  'auth.passwordStrength.good': 'Good',
  'auth.passwordStrength.strong': 'Strong',
  'auth.enterValidEmail': 'Enter a valid email address',
  'auth.emailRequired': 'Email is required',
  'auth.passwordRequired': 'Password is required',
  'auth.passwordTooWeak': 'Password is too weak',
  'auth.fullNameRequired': 'Full name is required',
  'auth.passwordMinLength': 'Password must be at least {min} characters',
  'auth.passwordMaxLength': 'Password must be at most {max} characters',
  'auth.passwordMustContainLetters': 'Password must contain letters',
  'auth.passwordMustContainNumbers': 'Password must contain numbers',
  'auth.notice.verificationSent.help': "Don't see the email?",
  'auth.notice.verificationSent.help.checkSpam': 'Check your spam/junk folder',
  'auth.notice.verificationSent.help.waitMinutes':
    'Wait a few minutes for delivery',
  'auth.notice.verificationSent.help.tryNewAccount':
    'Try creating a new account if needed',
  'auth.signUp.verifying': 'Verifying...',
  'auth.signUp.resending': 'Resending...',
  'auth.signUp.resendCode': 'Resend Code',
  'auth.signUp.verifyEmail': 'Verify Email',
  'auth.signUp.enterVerificationCode': 'Enter verification code',

  // Dashboard messages

  // Dashboard hero + search

  // Auth notices
  'auth.notice.unauthenticated.title': 'Please sign in to continue',
  'auth.notice.unauthenticated.desc':
    'You tried to access a protected page. Sign in to continue',
  'auth.notice.unauthorized.title': "You don't have access to that page",
  'auth.notice.unauthorized.desc':
    'Try signing in with a different account or contact support if you believe this is a mistake',
  'auth.notice.accountCreated.title': 'Account created successfully!',
  'auth.notice.accountCreated.desc':
    'Your account has been created. Please check your email for a verification link to activate your account',
  'auth.notice.accountCreatedVerified.title': 'Account created and verified!',
  'auth.notice.accountCreatedVerified.desc':
    'Your account has been created and your email is verified. You can now sign in below',
  'auth.notice.accountCreatedVerifyNeeded.title': 'Account created',
  'auth.notice.accountCreatedVerifyNeeded.desc':
    'Your account has been created. Please verify your email address before signing in',
  'auth.notice.verificationSent.title':
    'Account created! Please verify your email',
  'auth.notice.verificationSent.desc':
    "We've sent a verification email to your inbox. You must verify your email address before you can sign in. Please check your email and click the verification link, then return here to sign in",

  // Clerk error messages
  'auth.errors.somethingWentWrong': 'Something went wrong',
  'auth.errors.deviceNotTrusted':
    "This browser has not been approved for the development sign-in yet. Your email and password are fine. Try again from the app's own sign-in page, or contact us if it persists.",
  'auth.errors.signInInvalid':
    'Incorrect email or password. Try again, or reset your password',
  'auth.errors.formIdentifierNotFound':
    'No account found with this email. Please check your email or sign up for a new account',
  'auth.errors.formPasswordIncorrect':
    'Incorrect credentials. Please check and try again',
  'auth.errors.formParamFormatInvalidIdentifier':
    'Please enter a valid email address',
  'auth.errors.formParamFormatInvalidEmail':
    'Please enter a valid email address',
  'auth.errors.formParamFormatInvalid': 'Invalid format provided',
  'auth.errors.verificationFailed':
    'Please verify your email address before signing in',
  'auth.errors.checkCredentials': 'Please check your credentials and try again',
  'auth.errors.formIdentifierExists':
    'An account with this email already exists. Please try signing in instead',
  'auth.errors.formPasswordPwned':
    'This password has been found in a data breach. Please choose a different password',
  'auth.errors.formPasswordNotStrongEnough':
    'Password is not strong enough. Please choose a stronger password',
  'auth.errors.formPasswordTooCommon':
    'This password is too common. Please choose a more unique password',
  'auth.errors.checkInformation': 'Please check your information and try again',
  'auth.errors.invalidOrExpiredCode':
    'Invalid or expired code. Please try again',
  'auth.errors.failedToResendCode':
    'Failed to resend code. Please wait a moment and try again',

  // Wizard sections
  'wizard.loading': 'Loading wizard...',
  'wizard.details.title': "Let's get to know your project",
  'wizard.details.desc': 'Define Audience, Goals and more',
  'wizard.details.desc2':
    'Help us understand your business to generate better project suggestions',
  'wizard.details.howProceed': 'How do you want to proceed?',
  'wizard.details.allFieldsMandatory': 'All fields are mandatory',
  'wizard.summary.title': "Here's a summary of what you're creating",
  'wizard.summary.mainGoal': 'Main goal',
  'wizard.summary.instruction':
    'Looks good? Feel free to fine-tune before moving on, or press again the “AI assist” button to generate new ideas. ',
  'wizard.summary.editDetails': 'Edit details',
  'wizard.review.generatingPreview': 'Building "{projectName}"',
  'wizard.review.generatingPreviewSubtitle': 'Preparing your preview...',
  'wizard.template.selected': 'Selected Template',
  'wizard.template.title': 'Choose Site Structure',
  'wizard.template.descStructure': 'Pick how you want to build your website',
  'wizard.template.chooseYourTemplate': 'Choose template',
  'wizard.template.chooseYourStructure': 'Choose Site Structure',
  'wizard.template.tagline':
    'Pick a template to start customizing your website',
  'wizard.template.taglineStructure': 'Pick how you want to build your website',
  'wizard.template.templatesAvailable':
    '{count} templates available at your finger tips',
  'wizard.template.all': 'All',
  'wizard.template.noTemplatesFound':
    'No templates found matching your filters',
  'wizard.template.clearAllFilters': 'Clear all filters',
  'wizard.template.recommendedForYou': 'Recommended for you',
  'wizard.template.recommended': 'Recommended',
  'wizard.template.otherTemplates': 'Other templates',
  'wizard.template.allTemplates': 'All Other Templates',
  'wizard.template.myTemplates': 'My Templates',
  'wizard.template.flowstarterLibrary': 'Flowstarter Library',
  'wizard.design.title': 'Design & Branding',
  'wizard.design.desc': 'Customize the look and feel of your site',
  'wizard.review.title': 'Review & Launch',
  'wizard.review.desc': 'Review your website before launching it',
  'wizard.template.preview': 'Preview',

  // Coding Agent

  // Agent messages

  // Orchestrator messages

  // Preview messages

  // Wizard – Assistant Transition

  // Wizard – Choose Site Structure
  'wizard.chooseSiteStructure.title': 'Choose Site Structure',
  'wizard.chooseSiteStructure.description':
    'Select the perfect template for your project',

  // Wizard – Recommendations
  'wizard.recommendations.allSetChooseTemplate':
    "You're all set, now please choose the perfect template for your project",

  // Wizard – Blank Canvas / Scratch
  'wizard.scratch.startBlank': 'Start with Blank Canvas',
  'wizard.scratch.helperText':
    'You can change it later until you publish your website',

  // Wizard – Details Chat (ProjectDetailsChat component)
  'wizard.detailsChat.greeting': "Hi {name}, I'm your Flowstarter assistant",
  'wizard.detailsChat.greetingSubtext':
    "I'll help you shape your idea into a beautiful website, fast and easy",

  // Generate with AI assistant
  'ai.generateWithAI': 'Start with Smart Setup',
  'ai.letAIWorkForYou':
    'Let our smart tools do the heavy lifting for you, while you can still make edits',
  'ai.fillManually': 'Fill in manually',
  'ai.fillManuallyDescription': 'Do it as you want',
  'ai.assist': 'Smart Assist',
  'ai.industry': 'Industry',
  'ai.generationError': 'Generation error',
  'ai.connectionError': 'Connection error',
  'ai.aiServiceTookTooLongToRespond': 'The AI service took too long to respond',
  'ai.tooManyRequests': 'Too many requests',
  'ai.noBusinessInformation': 'Missing info',
  'ai.pleaseProvideBusinessInformation':
    'Please provide business information first',
  'ai.appliedToFieldsTitle': 'Applied smart suggestions',
  'ai.appliedToFieldsDescription':
    'We filled empty fields. Please review and adjust as needed before continuing',
  'ai.makeItShorter': 'Make it shorter',
  'ai.exploreAlternatives': 'Explore alternatives',
  'ai.makeItPunchy': 'Make it punchy',
  'ai.unableToGenerateSuggestions': 'Unable to generate suggestions',
  'ai.clarifyBenefits': 'Clarify benefits',
  'ai.customPrompt': 'Custom prompt',
  'ai.customPrompt.placeholder':
    'Describe exactly how you want this rewritten…',
  'ai.customPrompt.lengthHint': 'Please enter 1-2 sentences',
  'ai.customPrompt.valid': 'Ready to apply',

  // Field-specific custom prompt placeholders
  'ai.customPrompt.placeholder.name':
    'Describe the naming style, tone, and constraints (e.g., short, brandable, no hyphens)…',
  'ai.customPrompt.placeholder.uvp':
    'Explain the angle and benefits to emphasize (e.g., outcomes, differentiation, credibility)…',
  'ai.customPrompt.placeholder.description':
    'Give specific guidance (tone, length, details to include/avoid) for the project description…',
  'ai.generationFailed': 'Creation Failed',
  'ai.failedToGenerateSuggestions': 'Failed to create suggestions',
  'ai.aiResponseError': 'Response Error',
  'ai.aiServiceReturnedUnexpectedFormat': 'Service returned unexpected format',
  'ai.aiServiceDidNotGenerateContent': 'Service did not create content',
  'ai.unableToConnectToAIService': 'Unable to connect to service',
  'ai.timeoutError': 'Timeout Error',
  'ai.youveMadeTooManyRequestsRecently':
    'You have made too many requests recently',
  'ai.failedToGenerateUSP': 'Failed to create unique selling proposition',
  'ai.contentViolation': 'Content Policy Violation',
  'ai.pleaseReviewContent': 'Please review your content and try again',

  // Domain configuration
  'domain.hosted': 'Hosted Domain',
  'domain.custom': 'Custom Domain',
  'domain.recommended': 'Recommended for fast launch',
  'domain.config.title': 'Domain Configuration',
  'domain.config.subtitle': 'Choose how you want to set up your domain',
  'domain.config.ownershipQuestion':
    'How would you like to set up your domain?',
  'domain.config.owns': 'My Custom Domain',
  'domain.config.useExisting': 'Use my existing domain',
  'domain.config.wantsToBuy': 'Help me buy a domain',
  'domain.config.findAndPurchase': 'Find and purchase a domain',
  'domain.config.useHosted': 'Platform Hosted',
  'domain.config.freeSubdomain': 'Free subdomain on our platform',
  'domain.config.changeSelection': 'Change selection',
  'domain.hostedOption.title': 'Platform Hosted',
  'domain.hostedOption.freeSubdomainOn': 'Free subdomain on',
  'domain.customOption.title': 'My Custom Domain',
  'domain.customOption.useExisting': 'Use your existing domain',
  'domain.customOption.note': 'Use your own address. Requires DNS setup',
  'domain.customOption.useSuggested': 'Use',
  'domain.customOption.helpIntro': 'Enter your custom domain name',
  'domain.customOption.helpOwns':
    "You'll need to configure DNS settings after deployment",
  'domain.customOption.helpWantsToBuy':
    "We can help you check if it's available for purchase",
  'domain.buy.available': 'Suggested domains',
  'domain.buy.refresh': 'Refresh suggestions',
  'domain.buy.inputLabel': 'Enter a domain to check availability',
  'domain.buy.check': 'Check',
  'domain.buy.checking': 'Checking',
  'domain.buy.availableShort': 'appears available',
  'domain.buy.notAvailableShort': 'may not be available',
  'domain.buy.buyOnGoDaddy': 'Buy on GoDaddy',
  'domain.buy.buyOnRoTLD': 'Buy on RoTLD',
  'domain.buy.generating': 'Generating domain suggestions...',
  'domain.buy.enterName':
    'Enter a project name above to see domain suggestions',
  'domain.buy.postPurchaseHint':
    'After purchasing, return here and choose “My Custom Domain” to connect it',
  'domain.buy.pleaseTryAgainOrCheckWithYourRegistrar':
    'Please try again or check with your registrar',
  'domain.buy.couldNotVerifyAvailability': 'Could not verify availability',
  'domain.preview.availableAt': 'Your site will be available at:',
  'domain.preview.customConfigured': 'Custom domain configured',
  'domain.preview.hostedOn': 'Hosted on',
  'domain.validation.valid': 'Valid domain format',
  'domain.validation.invalid': 'Invalid domain format',
  'domain.validation.didYouMean': 'Did you mean:',
  'domain.config.subtitle2':
    'A domain is your website’s address (for example, mybusiness.com). You can start with a free hosted subdomain or connect your own',
  'domain.config.subtitle3':
    'Get a free subdomain today. You can connect your own domain later',
  'domain.config.hintChangeToCustomOrBuy':
    'Have a custom domain or want to purchase one? Click “Change selection” above and choose “My Custom Domain” or “Help me buy a domain.”',
  'domain.config.subdomain': 'subdomain',
  'domain.config.subtitle4':
    'Connect your own domain. You’ll verify ownership and update DNS after launch',
  'domain.autoSuggested': 'Auto-suggested from project name "{name}"',
  'domain.continueWithThisDomain': 'Use this domain',
  'domain.config.bestOption':
    'This will help us configure the best option for your project',

  // Domain ownership verification helper

  // Draft banners / dialogs
  'draft.inProgressDesc':
    'You have an ongoing draft. Pick up where you left off or start fresh',
  'draft.discardProgressTitle': 'Discard your progress?',
  'draft.discardProgressDesc':
    'This will delete your current draft and you will lose all unsaved changes',
  'draft.saveDraftFailed': 'Failed to save draft',
  'draft.saveDraftSuccess': 'Draft saved successfully',
  'draft.restoringDraft': 'Loading your dashboard…',
  'draft.saveDraftSuccessDescription':
    'You can continue anytime from your dashboard. Pick up where you left off or start a new project',
  'draft.saveDraftFailedDescription':
    'We could not save your progress. Please try again',
  'draft.discardingDraft': 'Discarding draft…',

  'dashboard.analytics.prospectSingular': 'prospect',
  'dashboard.analytics.prospectPlural': 'prospects',
  'dashboard.projects.continueSetup': 'Continue Setup',
  'dashboard.projects.inProgress': 'In progress',
  'dashboard.projects.draftPlaceholderName': 'Untitled site',

  // New Project Dropdown
  'newProject.dropdown.template.title': 'Start from a template',
  'newProject.dropdown.template.description':
    'Choose from our curated template gallery',
  'newProject.dropdown.scratch.title': 'Start from Scratch',
  'newProject.dropdown.scratch.description':
    'Build your project using our custom wizard',
  'newProject.dropdown.ai.title': 'Start using AI',
  'newProject.dropdown.ai.description':
    'Let AI help you create your project faster',
  'newProject.dropdown.interactive.title': 'Interactive Chat',
  'newProject.dropdown.interactive.description':
    'Chat with AI to build your project step by step',
  'newProject.dropdown.quickForm.title': 'Quick Form',
  'newProject.dropdown.quickForm.description':
    'Fill in your project details with a guided form',

  'dashboard.analytics.businessLeads': 'Business Leads',
  'dashboard.analytics.websiteTraffic': 'Website Traffic',
  'dashboard.analytics.views': 'Views',

  // Dashboard zero-state placeholders

  // Client dashboard stats cards
  'dashboard.stats.yourWebsite': 'Your Website',
  'dashboard.stats.live': 'Live',
  'dashboard.stats.inProgress': 'In Progress',
  'dashboard.stats.notStarted': 'Awaiting kickoff',
  'dashboard.stats.bookDiscovery': 'Schedule your kickoff call to begin',
  'dashboard.stats.buildingMessage':
    "Your website is being built. We'll notify you at each milestone",
  'dashboard.stats.edit': 'Edit',
  'dashboard.stats.view': 'View',
  'dashboard.stats.trafficAppears': 'Traffic data activates at launch',
  'dashboard.stats.leadsActivate': 'Lead tracking activates at launch',
  'dashboard.stats.aiCreditsReset': 'Resets monthly',
  'dashboard.stats.integrations': 'Integrations',
  'dashboard.stats.integrationsSetup': 'Set up',
  'dashboard.stats.integrationsAfterLaunch': 'After launch',
  'dashboard.stats.integrationsConnect': 'Analytics, email, calendar',
  'dashboard.stats.integrationsConnectLater': 'Available after launch',
  'dashboard.stats.analytics': 'Analytics',
  'dashboard.stats.email': 'Email',
  'dashboard.stats.calendar': 'Calendar',

  // Dashboard page

  // Premium dashboard - milestones
  'dashboard.stepper.strategy': 'Strategy',
  'dashboard.stepper.strategyDescription':
    'Goals, audience, and positioning defined',
  'dashboard.stepper.design': 'Design',
  'dashboard.stepper.designDescription':
    'Brand, layout, and visual identity finalized',
  'dashboard.stepper.development': 'Development',
  'dashboard.stepper.developmentDescription':
    'Pages built, content placed, SEO configured',
  'dashboard.stepper.launch': 'Launch',
  'dashboard.stepper.launchDescription': 'Live site + smart editor access',
  'dashboard.stepper.milestone': 'Phase {number}',
  'dashboard.stepper.done': 'Complete',

  // Premium dashboard - AI capabilities
  'dashboard.stats.aiCapabilities': 'AI Assistant',
  'dashboard.stats.aiCapabilitiesActive': 'Ready',
  'dashboard.stats.aiCreditsAvailable': 'Claude Code usage managed by Claude',
  'dashboard.stats.aiCapability.copy': 'Refine your copy',
  'dashboard.stats.aiCapability.sections': 'Optimize sections',
  'dashboard.stats.aiCapability.seo': 'Improve SEO',
  'dashboard.stats.aiCapability.images': 'Enhance visuals',
  'dashboard.stats.aiUnlockedAfterSetup': 'Available once your site is live',

  // Premium dashboard - primary action
  'dashboard.action.requestChange': 'Request a Change',
  'dashboard.action.requestChangeSub': 'Our team will implement it within 24h',
  'dashboard.action.uploadAssets': 'Upload Assets',

  // Premium dashboard - build phase
  'dashboard.action.kickoffTitle': "Let's get your website started",
  'dashboard.action.kickoffDesc':
    'A 30-minute call to define your goals. We handle the rest',
  'dashboard.stats.buildPhase': 'Build in progress',
  'dashboard.stats.buildPhaseActive': 'In progress',
  'dashboard.stats.currentMilestone': 'Current phase: {phase}',
  'dashboard.greeting.morning': 'Good morning',
  'dashboard.greeting.afternoon': 'Good afternoon',
  'dashboard.greeting.evening': 'Good evening',
  'dashboard.greeting.night': 'Good night',
  'dashboard.title': 'Project Overview',
  'dashboard.loading': 'Loading your workspace...',

  // Onboarding stepper
  'dashboard.stepper.bookCallButton': 'Get my custom plan',

  // Dashboard details link
  'dashboard.details': 'Details',

  // Dashboard traffic stats
  'dashboard.analytics.visitors': '{count} visitors',
  'dashboard.analytics.avgSession': '{minutes}min avg',
  'dashboard.analytics.conversionRateValue': '{rate}% conversion rate',

  // Team / admin login
  'team.login.title': 'Admin Login',
  'team.login.subtitle':
    'Sign in to manage client projects and configure services',
  'team.login.signInTitle': 'Sign in to your account',
  'team.login.signInSubtitle':
    'Team access only. Contact admin for credentials',
  'team.login.emailLabel': 'Email address',
  'team.login.emailPlaceholder': 'you@flowstarter.net',
  'team.login.passwordLabel': 'Password',
  'team.login.passwordPlaceholder': 'Enter your password',
  'team.login.signingIn': 'Signing in...',
  'team.login.signIn': 'Sign in',

  // Team sidebar
  'team.sidebar.dashboard': 'Dashboard',
  'team.sidebar.configuration': 'Configuration',
  'team.sidebar.domains': 'Domains',
  'team.sidebar.email': 'Email',
  'team.sidebar.analytics': 'Analytics',
  'team.sidebar.services': 'Services',
  'team.sidebar.team': 'Team',
  'team.sidebar.invite': 'Invite Team Member',

  // Industries (translatable category keys - normalized to id-without-dashes)

  // Project status labels (shared across team + client dashboards)
  'status.live': 'Live',
  'status.building': 'Building',
  'status.draft': 'Draft',

  // Team dashboard
  'team.dashboard.totalProjects': 'Total Projects',
  'team.dashboard.revenue': 'Revenue',
  'team.dashboard.details': 'Details',
  'team.dashboard.allProjects': 'All Projects',
  'team.dashboard.allProjectsDescription':
    'View and manage all client projects',
  'team.dashboard.noProjects': 'No projects yet',
  'team.dashboard.statsLoadError':
    'Could not load dashboard stats. Refresh the page or try again shortly',
  'team.dashboard.lastEdit': 'Last edit: {time}',
  'team.dashboard.countLive': '{count} live',
  'team.dashboard.countBuilding': '{count} building',
  'team.dashboard.countDraft': '{count} draft',
  'team.dashboard.countPaid': '{count} paid',
  'team.dashboard.setupFees': '{amount} setup',
  'team.dashboard.monthlyRevenue': '{amount}/mo',

  // Team projects table & dialogs
  'team.dashboard.table.project': 'Project',
  'team.dashboard.table.status': 'Status',
  'team.dashboard.table.owner': 'Owner',
  'team.dashboard.table.updated': 'Updated',
  'team.dashboard.untitledProject': 'Untitled Project',
  'team.dashboard.unknownOwner': 'Unknown',
  'team.dashboard.deleteProject': 'Delete Project',
  'team.dashboard.deleteConfirm':
    'Are you sure you want to delete "{name}"? This action cannot be undone',
  'team.dashboard.renameProject': 'Rename Project',
  'team.dashboard.projectNamePlaceholder': 'Project name',
  'team.dashboard.projectPricing': 'Project Pricing',
  'team.dashboard.betaDiscount': 'Beta -50%',
  'team.dashboard.projectType': 'Project Type',
  'team.dashboard.typeStandard': 'Standard',
  'team.dashboard.typePro': 'Pro',
  'team.dashboard.typeBusiness': 'Business',
  'team.dashboard.setupFee': 'Setup Fee',
  'team.dashboard.monthlyFee': 'Monthly Fee',
  'team.dashboard.paymentReceived': 'Payment Received',
  'team.dashboard.paymentReceivedDesc': 'Mark as paid to count in revenue',
  'team.dashboard.paid': 'Paid',
  'team.dashboard.perMonth': '/mo',
  'team.dashboard.setup': 'setup',

  // Team project actions
  'team.dashboard.actions.openInEditor': 'Open in Editor',
  'team.dashboard.actions.viewSite': 'View Site',
  'team.dashboard.actions.configureDomain': 'Configure Domain',
  'team.dashboard.actions.setupEmail': 'Setup Email',
  'team.dashboard.actions.analytics': 'Analytics',
  'team.dashboard.actions.rename': 'Rename',
  'team.dashboard.actions.pricing': 'Pricing',
  'team.dashboard.actions.delete': 'Delete',

  // Team project toast messages
  'team.dashboard.toast.deleteSuccess': 'Project deleted successfully',
  'team.dashboard.toast.deleteFailed': 'Failed to delete project',
  'team.dashboard.toast.renameSuccess': 'Project renamed successfully',
  'team.dashboard.toast.renameFailed': 'Failed to rename project',
  'team.dashboard.toast.pricingSuccess': 'Pricing updated successfully',
  'team.dashboard.toast.pricingFailed': 'Failed to update pricing',
  'team.dashboard.toast.editorFailed': 'Failed to open project in editor',
  'team.dashboard.aiCredits': 'AI usage',
  'team.dashboard.cost': 'cost',

  // Client requests
  'team.dashboard.clientRequests': 'Client Requests',
  'team.dashboard.clientRequests.allCaughtUp': 'All caught up',
  'team.dashboard.clientRequests.noRequests': 'No client requests yet',
  'team.sidebar.clientRequests': 'Client Requests',

  // Common action labels
  'app.save': 'Save',
  'app.delete': 'Delete',
  'app.deleting': 'Deleting...',

  // UI components
  'tagsInput.noSuggestions': 'No suggestions',

  // Navigation
  'nav.create': 'Create',
  'nav.features': 'Features',
  'nav.pricing': 'Pricing',
  'nav.benefits': 'Benefits',
  'nav.signIn': 'Sign In',
  'nav.signUp': 'Sign Up',

  // Theme

  // Dashboard headers
  'dashboard.analytics.title': 'Analytics Overview',
  'dashboard.analytics.subtitle': 'Track your progress and performance metrics',

  // Projects list
  'projects.title': 'My Projects',
  'projects.subtitle': 'Manage and track your business websites',
  'projects.new': 'New Project',
  'projects.status.completed': 'Completed',
  'projects.status.generating': 'Generating',
  'projects.status.unknown': 'Unknown',
  'projects.delete': 'Delete Project',
  'projects.deleteDialog.title': 'Delete Project',
  'projects.deleteDialog.description':
    'Are you sure you want to delete "{name}"? This action cannot be undone and all project data will be permanently removed',
  'projects.deleteDialog.cancel': 'Cancel',
  'projects.deleteDialog.delete': 'Delete Project',
  'projects.deleteDialog.deleting': 'Deleting...',
  'projects.deleteSuccess': 'Project deleted successfully',
  'projects.deleteFailed': 'Failed to delete project',
  'projects.rename': 'Rename Project',
  'projects.renameComingSoon': 'Rename functionality coming soon',
  'projects.lastEdit': 'Last edit',
  'projects.fromTemplate': 'From template',
  'projects.noTemplateSelected': 'No template selected',
  'projects.time.justNow': 'Just now',
  'projects.time.hour': 'hour',
  'projects.time.hours': 'hours',
  'projects.time.day': 'day',
  'projects.time.days': 'days',
  'projects.time.ago': 'ago',

  // Profile

  // Integrations
  'integrations.active': 'Active',
  'integrations.available': 'Available',
  'integrations.status.connected': 'Connected',
  'integrations.status.notConnected': 'Not connected',
  'integrations.keyFeatures': 'KEY FEATURES',
  'integrations.disconnect': 'Disconnect',
  'integrations.connecting': 'Connecting...',
  'integrations.custom.title': 'Need a Custom Integration?',
  'integrations.custom.description':
    "Let us know which tools you need and we'll help you connect them",
  'integrations.custom.requestButton': 'Request Integration',
  'integrations.connect': 'Connect',

  // Calendly Integration
  'integrations.calendly.name': 'Calendly',
  'integrations.calendly.description':
    'Schedule meetings and appointments directly from your website',
  'integrations.calendly.features.scheduling': 'Automated scheduling',
  'integrations.calendly.features.reminders': 'Email reminders',
  'integrations.calendly.features.timezone': 'Timezone detection',
  'integrations.calendly.tutorialUrl':
    'https://www.youtube.com/watch?v=calendly-tutorial',
  // Calendly setup guide
  'integrations.calendly.errors.apiKeyRequired': 'API key is required',
  'integrations.calendly.errors.apiKeyTooShort':
    'API key must be at least 10 characters',
  'integrations.calendly.errors.eventUrlRequired': 'Event URL is required',
  'integrations.calendly.errors.eventUrlInvalid': 'Invalid URL format',
  'integrations.calendly.errors.eventUrlHost': 'URL must be on calendly.com',

  // Mailchimp Integration
  'integrations.mailchimp.name': 'Mailchimp',
  'integrations.mailchimp.description':
    'Sync your email list and manage campaigns',
  'integrations.mailchimp.features.contactSync': 'Contact sync',
  'integrations.mailchimp.features.campaignManagement': 'Campaign management',
  'integrations.mailchimp.features.emailAnalytics': 'Email analytics',
  'integrations.mailchimp.tutorialUrl':
    'https://www.youtube.com/watch?v=mailchimp-tutorial',
  // Mailchimp setup guide
  'integrations.mailchimp.errors.apiKeyRequired': 'API key is required',
  'integrations.mailchimp.errors.apiKeyInvalid':
    'Invalid API key format (e.g., abc123-us21)',
  'integrations.mailchimp.errors.audienceIdRequired': 'Audience ID is required',
  'integrations.mailchimp.errors.audienceIdInvalid': 'Audience ID is too short',

  // Google Analytics Integration
  'integrations.googleAnalytics.name': 'Google Analytics',
  'integrations.googleAnalytics.description':
    'Track visitor behavior, traffic sources, and conversions on your generated websites',

  // Help - Overview

  // Help - Common

  // Help - Breadcrumbs

  // Help - Getting Started

  // Help - Getting Started Steps

  // Help - Template Selection

  // Help - Template Selection Steps

  // Help - Template Selection Templates

  // Help - Customization

  // Help - Customization Steps

  // Help - Customization Areas

  // Help - Customization Tools

  // Help - Deployment

  // Sidebar
  'sidebar.main': 'Main',
  'sidebar.support': 'Support',
  'sidebar.dashboard': 'Dashboard',
  'sidebar.integrations': 'Integrations',
  'sidebar.bookFreeCall': 'Get my custom plan',
  'sidebar.scheduleCheckin': 'Schedule Check-in',
  'sidebar.helpGuide': 'Help Guide',

  // Footer
  'footer.links.helpCenter': 'Help Center',
  'footer.links.privacyPolicy': 'Privacy Policy',
  'footer.links.termsOfService': 'Terms of Service',
  'footer.social.twitterAria': 'Follow us on Twitter',
  'footer.social.linkedinAria': 'Follow us on LinkedIn',
  'footer.social.githubAria': 'Follow us on GitHub',
  'footer.social.discordAria': 'Join our Discord',
  'footer.copyright': '© {year} Flowstarter, Inc. All rights reserved',
  'footer.buildWith': 'Built with',
  'footer.byTeam': 'by the Flowstarter team',
  'footer.nav.help': 'Help',
  'footer.nav.privacy': 'Privacy',
  'footer.nav.terms': 'Terms',
  'footer.nav.contact': 'Contact',
  'footer.nav.teamDashboard': 'Team Dashboard',
  'footer.nav.editor': 'Editor',
  'footer.nav.clientLogin': 'Client Login',
  'footer.nav.cookies': 'Cookie settings',
  'footer.nav.about': 'About',
  'footer.nav.faq': 'FAQ',

  // Landing page

  // Features section

  // How it works section

  // Templates section

  // Testimonials section

  // Pricing section

  // Benefits section

  // Error page
  'error.title': 'Something went wrong',
  'error.subtitle':
    "We encountered an unexpected error. Don't worry, we've been notified and are working to fix it",
  'error.reload': 'Reload Page',
  'error.goHome': 'Go to Homepage',
  'error.whatHappened': 'What happened?',
  'error.explanation':
    'A technical error occurred while loading this page. This could be due to:',
  'error.reason1': 'A temporary server issue',
  'error.reason2': 'A network connectivity problem',
  'error.reason3': 'An unexpected application error',
  'error.contactSupport': 'If this continues, please contact our support team',

  // Not Found page

  // Error - Code Generation
  'error.generation.tryAgain': 'Try Again',
  'error.generation.retrying': 'Retrying...',

  // Database offline
  'database.offline.title': 'Database Offline',
  'database.offline.subtitle':
    "We're having trouble connecting to our database. This might be temporary",
  'database.offline.connectionStatus': 'Connection Status:',
  'database.offline.offlineSince': 'Offline since {time}',
  'database.offline.retryConnection': 'Retry Connection',
  'database.offline.checkingConnection': 'Checking Connection...',
  'database.offline.whatYouCanDo': 'What you can do:',
  'database.offline.action1': 'Wait a moment and try again',
  'database.offline.action2': 'Check your internet connection',
  'database.offline.action3': 'Contact support if the issue persists',

  // CTA section

  // Content moderation
  'moderation.termsOfService': 'Terms of Service',
  'moderation.contentGuidelines': 'Content Guidelines',
  'moderation.inline.title': 'Content Policy Violation',

  // Help page common translations

  // Platform Types
  'platformType.label': 'What type of site do you need?',
  'platformType.businessSite': 'Business Site',
  'platformType.businessSiteDesc': 'Professional business website',
  'platformType.personalBrand': 'Personal Brand',
  'platformType.personalBrandDesc': 'Personal brand or professional profile',
  'platformType.portfolio': 'Portfolio Site',
  'platformType.portfolioDesc': 'Showcase your work and projects',

  // Wizard platform translations for kebab-case keys

  // Platform Type kebab-case keys (used by PlatformTypeSection)

  // My Templates (Dashboard) page

  // Dashboard Hero Action Cards

  // Examples Page
  'examples.title': 'Example Sites Gallery',
  'examples.subtitle':
    "Get inspired by real websites built with Flowstarter. See what's possible and start building your own",
  'examples.searchPlaceholder': 'Search example sites...',
  'examples.featured': 'Featured',
  'examples.categoryLabel': 'Category',
  'examples.industryLabel': 'Industry',
  'examples.pleaseTryAgain': 'Please try again later',
  'examples.noSitesFound': 'No example sites found matching your criteria',
  'examples.noSitesAvailable': 'No example sites available yet',
  'examples.clearFilters': 'Clear Filters',
  'examples.sitesFound': 'site{plural} found',
  'examples.cta.browseTemplates': 'Browse Templates',

  // Template Names

  // Profile Page
  'profile.userNotFound': 'User not found',
  'profile.userNotFound.description':
    'Please try refreshing the page or signing in again',
  'profile.personalInformation.title': 'Personal Information',
  'profile.personalInformation.firstName': 'First Name',
  'profile.personalInformation.lastName': 'Last Name',
  'profile.personalInformation.email': 'Email',
  'profile.accountDetails.title': 'Account Details',
  'profile.accountDetails.created': 'Created',
  'profile.accountDetails.lastUpdated': 'Last Updated',

  // Analytics Page

  // Flowstarter Assistant
  'assistant.input.description':
    'Tell us your project idea and we will create the project details and guide you to build it',
  'assistant.input.description.details':
    'Be specific and offer details about the: industry, type of product (landing page or website), audience, goals, visual style',
  'assistant.validation.needMoreContent':
    'Need more content ({current}/{required} words)',
  'assistant.validation.briefDescription':
    'Please add a brief description (1-2 phrases) of what you want to create',
  'assistant.button.generating': 'Creating...',
  'assistant.button.quickMode': 'Quick Mode - AI powered',
  'assistant.button.generate': 'Create',
  'assistant.button.uploading': 'Uploading...',
  'assistant.button.attachImage': 'Attach image',
  'assistant.messages.contentNotAllowed': 'Content not allowed',
  'assistant.messages.somethingWentWrong': 'Something went wrong',
  'assistant.steps.checkingContent': 'Checking content safety',
  'assistant.steps.analyzingBusiness': 'Understanding your business idea',
  'assistant.steps.generatingDetails': 'Creating project details',
  'assistant.steps.preparingProject': 'Setting up your project',
  'assistant.steps.industryDetected': 'Industry detected',
  'assistant.toast.success': 'Project details generated!',
  'assistant.toast.successDescription':
    'Taking you to customize your project...',
  'assistant.toast.error': 'Failed to process your request',
  'assistant.toast.errorDescription': 'Please try again',
  // Assistant prompt suggestions
  'assistant.prompts.greeting':
    'Hi {user}, here are some prompt examples you can use (click to use):  ',
  'assistant.prompts.projectDetailsGreeting':
    'here are some prompts examples you can use',
  'assistant.prompts.expand': 'Show more',
  'assistant.prompts.collapse': 'Show less',
  'assistant.prompts.examples.saas':
    'A minimalist landing page for a SaaS product in the IT industry that helps teams collaborate better',
  'assistant.prompts.examples.localBusiness':
    'Build a website for my local coffee shop in Brooklyn with online ordering and event calendar',
  'assistant.prompts.examples.portfolio':
    'A consulting site for a business coach offering 1-on-1 sessions and online courses, all in corporate style with light & dark theme',
  'assistant.prompts.examples.ecommerce':
    'Launch an online store for handmade candles with product catalog and checkout',
  'assistant.prompts.examples.agency':
    'Create a digital marketing agency website targeting small businesses who need social media help',
  'assistant.prompts.examples.consulting':
    'Build a consulting site for a business coach offering 1-on-1 sessions and online courses',
  // Industry-specific prompt examples
  'assistant.prompts.industry.consultantscoaches.1':
    'A website for a business coach helping entrepreneurs scale their startups',
  'assistant.prompts.industry.consultantscoaches.2':
    'A consulting site for a marketing strategist targeting small businesses',
  'assistant.prompts.industry.consultantscoaches.3':
    'A life coaching website focused on career transitions and work-life balance',
  'assistant.prompts.industry.therapistspsychologists.1':
    'A calming website for a therapist specializing in anxiety and depression',
  'assistant.prompts.industry.therapistspsychologists.2':
    'A psychology practice site offering online and in-person counseling',
  'assistant.prompts.industry.therapistspsychologists.3':
    'A family therapist website with booking system for couples and individual sessions',
  'assistant.prompts.industry.photographersvideographers.1':
    'A portfolio site for a wedding photographer showcasing 200+ weddings',
  'assistant.prompts.industry.photographersvideographers.2':
    'A videography website for corporate events and brand storytelling',
  'assistant.prompts.industry.photographersvideographers.3':
    'A portrait photographer site with online booking and pricing packages',
  'assistant.prompts.industry.designerscreativestudios.1':
    'A portfolio website for a freelance graphic designer showcasing creative work',
  'assistant.prompts.industry.designerscreativestudios.2':
    'A creative studio site offering branding, web design, and UX services',
  'assistant.prompts.industry.designerscreativestudios.3':
    'A UI/UX designer portfolio with interactive case studies and client testimonials',
  'assistant.prompts.industry.personaltrainerswellness.1':
    'A fitness coach website offering personalized training plans and nutrition advice',
  'assistant.prompts.industry.personaltrainerswellness.2':
    'A wellness expert site with online courses for stress management and mindfulness',
  'assistant.prompts.industry.personaltrainerswellness.3':
    'A personal training business with class schedules and membership tiers',
  'assistant.prompts.industry.salonsbarbersspas.1':
    'A modern hair salon website with online booking and style gallery',
  'assistant.prompts.industry.salonsbarbersspas.2':
    'A barber shop site targeting young professionals with trendy cuts',
  'assistant.prompts.industry.salonsbarbersspas.3':
    'A spa and wellness center with treatment menu and gift certificates',
  'assistant.prompts.industry.restaurantscafes.1':
    'A website for a local bakery in San Francisco that specializes in sourdough bread',
  'assistant.prompts.industry.restaurantscafes.2':
    'An Italian restaurant site with online reservations and seasonal menu',
  'assistant.prompts.industry.restaurantscafes.3':
    'A cozy café website with menu, online ordering, and loyalty program',
  'assistant.prompts.industry.contentcreation.1':
    'A content creator portfolio with YouTube, blog, and sponsorship info',
  'assistant.prompts.industry.contentcreation.2':
    'A podcast website with episode library and sponsor integration',
  'assistant.prompts.industry.contentcreation.3':
    'A social media influencer site with brand partnerships and media kit',
  'assistant.prompts.industry.fashionbeauty.1':
    'A fashion stylist portfolio targeting professionals and special events',
  'assistant.prompts.industry.fashionbeauty.2':
    'A beauty brand website selling organic skincare products',
  'assistant.prompts.industry.fashionbeauty.3':
    'A makeup artist portfolio with before/after gallery and booking system',
  'assistant.prompts.industry.healthwellness.1':
    'A nutritionist website offering meal plans and health consultations',
  'assistant.prompts.industry.healthwellness.2':
    'A holistic health center with services for acupuncture and yoga therapy',
  'assistant.prompts.industry.healthwellness.3':
    'A wellness retreat center with program schedule and registration',
  'assistant.prompts.industry.other.1':
    'A landing page for a SaaS product that helps teams collaborate better',
  'assistant.prompts.industry.other.2':
    'A marketing agency website that targets startups and small businesses',
  'assistant.prompts.industry.other.3':
    'An e-commerce site for selling handmade jewelry targeted at young professionals',

  // Feedback
  'feedback.title': 'Send Feedback',
  'feedback.description':
    "We'd love to hear your thoughts! Share your ideas, report bugs, or suggest improvements",
  'feedback.category.label': 'Category',
  'feedback.category.placeholder': 'Select a category',
  'feedback.category.bug': 'Bug Report',
  'feedback.category.feature': 'Feature Request',
  'feedback.category.improvement': 'Improvement',
  'feedback.category.other': 'Other',
  'feedback.message.label': 'Message',
  'feedback.message.placeholder': 'Tell us what you think...',
  'feedback.message.characters': 'characters',
  'feedback.email.label': 'Email',
  'feedback.email.optional': 'optional',
  'feedback.email.placeholder': 'your.email@example.com',
  'feedback.cancel': 'Cancel',
  'feedback.submit': 'Submit Feedback',
  'feedback.success': 'Thank you for your feedback!',
  'feedback.error.required': 'Please select a category and enter a message',
  'feedback.error.tooShort': 'Message must be at least 10 characters',
  'feedback.error.submit': 'Failed to submit feedback. Please try again',
  'sidebar.feedback': 'Feedback',

  'editor.attachImage': 'Attach Image',
  'editor.attachedImageAlt': 'Attached image',
  'editor.removeImage': 'Remove image',
  'editor.inputPlaceholder':
    "Tell me what you'd like to change about colors, layout, content, or anything else...",
  'editor.openInNewTab': 'Open in new tab',

  // Pricing Page

  // Billing toggle

  // Plan names

  // Plan descriptions

  // Plan CTAs

  // Credits

  // Sites

  // Popular badge

  // Features - Free tier

  // Features - Starter tier

  // Features - Pro tier

  // Features - Business tier

  // What Can You Build section

  // Credit Packs section

  // Why Choose section

  // FAQ section

  // CTA section

  // Landing Page - Hero

  // What's Included section

  // FAQ Section

  // Nav
  'nav.faq': 'FAQ',

  // Coming soon tiers

  // Landing Page - Stats
  'landing.stats.weeks': 'Custom',
  'landing.stats.weeksLabel': 'EVERY SITE, CUSTOM-BUILT',
  'landing.stats.calls': '1',
  'landing.stats.callsLabel': 'ONE CALL TO START',
  'landing.stats.techSkills': '0',
  'landing.stats.techSkillsLabel': 'TECH WORK ON YOUR SIDE',

  // Landing Page - How it works

  // How it works - 3 steps

  // Landing Page - Editor
  'landing.editor.title': 'Update your site anytime',
  'landing.editor.subtitle':
    'Just type what you want to change. Our AI editor does the rest',

  // Landing Page - Pricing Card

  // Landing Page - Pricing Features

  'landing.header.cta': 'Build my site',

  // Landing Page - For/Not For

  // Landing Page - CTA

  // Landing Page - Footer CTA

  // Three Pillars

  // Team Section

  // Landing Hero - Price Pill

  // Landing - Process Heading

  // Landing - FAQ Heading

  // Landing - Trust Section

  // Landing - Included note

  // Landing - Header Nav
  'nav.process': 'Process',
  'nav.theme': 'Theme',
  'nav.smartEditor': 'Smart editor',

  // Cookie Consent
  'cookie.title': 'We use cookies',
  'cookie.description':
    'Essential cookies to make Flowstarter work, plus analytics to improve your experience. No advertising or cross-site tracking',
  'cookie.learnMore': 'Learn more',
  'cookie.acceptAll': 'Accept all',
  'cookie.essentialOnly': 'Essential only',
  'cookie.settings': 'Settings',

  // Support Header
  'header.profile': 'Profile',
  'header.dashboard': 'Dashboard',
  'header.signOut': 'Sign out',
  'header.signIn': 'Sign in',

  // Footer Compact
  'footer.nav.editorLabel': 'Editor',

  // Error Page Layout
  'error.backToHome': '\u2190 Back to home',

  // Mock Editor Preview
  'mockEditor.chatTitle': '\u2728 Smart assistant',
  'mockEditor.assistantName': 'Flowstarter Assistant',
  'mockEditor.inputPlaceholder': 'Try: Add form...',
  'mockEditor.quickPrompt.pricing': 'Clarify this price',
  'mockEditor.quickPrompt.contact': 'Rewrite with options',
  'mockEditor.quickPrompt.colors': 'Match our tone',
  'mockEditor.rewrite.open': 'Rewrite with options',
  'mockEditor.rewrite.what': 'What to rewrite',
  'mockEditor.rewrite.how': 'How it should feel',
  'mockEditor.rewrite.target.headline': 'Headline',
  'mockEditor.rewrite.target.introduction': 'Introduction',
  'mockEditor.rewrite.target.cta': 'Main button',
  'mockEditor.rewrite.direction.warmer': 'Warmer',
  'mockEditor.rewrite.direction.shorter': 'Shorter',
  'mockEditor.rewrite.direction.moreConfident': 'More confident',
  'mockEditor.rewrite.direction.moreDirect': 'More direct',
  'mockEditor.rewrite.apply': 'Apply rewrite',
  'mockEditor.tools': 'Editing options',
  'mockEditor.tool.rewrite': 'Rewrite',
  'mockEditor.tool.price': 'Price',
  'mockEditor.tool.tone': 'Tone',
  'mockEditor.tool.translate': 'Translate',
  'mockEditor.target.headline': 'Headline',
  'mockEditor.target.introduction': 'Introduction',
  'mockEditor.target.service': 'Service description',
  'mockEditor.target.cta': 'Main button',
  'mockEditor.price.amount': 'Amount',
  'mockEditor.price.cadence': 'Billing',
  'mockEditor.price.delivery': 'Delivery',
  'mockEditor.price.cadence.twoWeeks': 'Every 2 weeks',
  'mockEditor.price.cadence.monthly': 'Monthly',
  'mockEditor.price.delivery.included': 'Included',
  'mockEditor.price.delivery.separate': 'Calculated separately',
  'mockEditor.price.apply': 'Apply price',
  'mockEditor.tone.what': 'Text to adjust',
  'mockEditor.tone.how': 'Desired voice',
  'mockEditor.tone.warm': 'Warm',
  'mockEditor.tone.calm': 'Calm',
  'mockEditor.tone.playful': 'Playful',
  'mockEditor.tone.expert': 'Expert',
  'mockEditor.tone.apply': 'Apply tone',
  'mockEditor.translate.what': 'Text to translate',
  'mockEditor.translate.language': 'Language',
  'mockEditor.translate.romanian': 'Romanian',
  'mockEditor.translate.french': 'French',
  'mockEditor.translate.spanish': 'Spanish',
  'mockEditor.translate.apply': 'Apply translation',
  'mockEditor.browserUrl': 'yoursite.com',
  'mockEditor.liveIndicator': 'LIVE',
  'mockEditor.site.brand': 'CoffeeRoast',
  'mockEditor.site.brandInitial': 'C',
  'mockEditor.site.nav.home': 'Home',
  'mockEditor.site.nav.about': 'About',
  'mockEditor.site.nav.shop': 'Shop',
  'mockEditor.site.nav.contact': 'Contact',
  'mockEditor.site.shopNow': 'Shop Now',
  'mockEditor.site.getInTouch': 'Get in Touch',
  'mockEditor.site.form.name': 'Name',
  'mockEditor.site.form.email': 'Email',
  'mockEditor.site.form.message': 'Message...',
  'mockEditor.site.form.send': 'Send',
  'mockEditor.site.blends': 'Our Blends',
  'mockEditor.site.testimonials': 'What Customers Say',
  'mockEditor.site.pricing': 'Pricing',
  'mockEditor.site.basicPlan': 'Basic',
  'mockEditor.site.basicPrice': '$9/mo',
  'mockEditor.site.proPlan': 'Pro',
  'mockEditor.site.proPrice': '$29/mo',
  'mockEditor.site.popular': 'POPULAR',
  'mockEditor.floatingDraft': 'Draft',
  'mockEditor.floatingTime': 'Just saved',

  // Contact Page (editorial redesign)
  'contact.eyebrow': 'Contact',
  'contact.headlinePrefix': "Let's talk.",
  'contact.headlineFlourish': 'Properly. No sales script.',
  'contact.sub':
    'Send a message, book a call, or write to us directly. You always reach one of the two founders, never a queue.',
  'contact.form.kicker': 'Send a message',
  'contact.form.title': 'Write to the founders.',
  'contact.form.replyGuarantee':
    'Every message gets a reply within one business day. Weekends excluded.',
  'contact.form.successTitle': 'Message sent.',
  'contact.form.successBody':
    'We will reply within one business day. Keep an eye on your inbox.',
  'contact.form.sendAnother': 'Send another message',
  'contact.form.nameLabel': 'Your name',
  'contact.form.namePlaceholder': 'Sarah Smith',
  'contact.form.emailLabel': 'Email',
  'contact.form.emailPlaceholder': 'you@example.com',
  'contact.form.subjectLabel': 'What is this about?',
  'contact.form.subjectDefault': 'Pick a topic',
  'contact.form.subjectGeneral': 'General question',
  'contact.form.subjectProject': 'New project',
  'contact.form.subjectSupport': 'Support for an existing site',
  'contact.form.subjectBilling': 'Billing',
  'contact.form.subjectPress': 'Press',
  'contact.form.subjectOther': 'Other',
  'contact.form.messageLabel': 'Your message',
  'contact.form.messagePlaceholder':
    'Tell us what you need. The more concrete, the better.',
  'contact.form.defaultError': 'Something went wrong. Please try again.',
  'contact.form.sending': 'Sending\u2026',
  'contact.form.send': 'Send message',
  'contact.call.kicker': 'Discovery call',
  'contact.call.title': '30 minutes with the founders.',
  'contact.call.body':
    'The fastest way to find out if Flowstarter is right for you. We come prepared, no slides, no script.',
  'contact.call.cta': 'Get my custom plan',
  'contact.direct.kicker': 'Direct lines',
  'contact.direct.title': 'Reach us in one click.',
  'contact.direct.emailLabel': 'Email',
  'contact.direct.twitterLabel': 'X / Twitter',
  'contact.direct.linkedinLabel': 'LinkedIn',
  'contact.responseTime.label': 'Response time',
  'contact.responseTime.value': 'Within one business day, Mon\u2013Fri.',

  // Help Page — HelpContent component (hero, FAQ, CTA)
  'help.badge': 'Help center',
  'help.title': 'Need a hand?',
  'help.description':
    'Most answers are right here. If not, one of us is a short call away.',
  'help.loggedInTitle': 'Help and support',
  'help.loggedInDescription':
    'Find an answer fast, or reach one of us directly.',
  'help.faqTitle': 'The questions we hear most',
  'help.cta.title': 'Still need to talk to a person?',
  'help.cta.description':
    'Book a free 30-minute call. We come prepared. No slides, just answers.',
  'help.cta.button': 'Get my custom plan',

  // Help Page (editorial redesign)
  'help.eyebrow': 'Help Center',
  'help.headlinePrefix': 'Need a hand?',
  'help.headlineFlourish': "We're right here.",
  'help.sub':
    'Search the answers below, scan the common topics, or just grab a free 30-minute call with us.',
  'help.card1.title': 'Get your custom plan',
  'help.card1.body':
    "Answer a few quick questions and we'll recommend the right plan. Then book a 30-minute call to talk it through, no commitment.",
  'help.card1.cta': 'Get my custom plan',
  'help.card2.title': 'Email us directly',
  'help.card2.body':
    'For account, billing, or technical questions. We reply within one business day.',
  'help.card3.title': 'Chat with the assistant',
  'help.card3.body':
    'Open the floating chat in the bottom-right corner. It answers most common questions on the spot.',
  'help.card3.badge': 'Live \u00b7 bottom-right',
  'help.faq.eyebrow': 'Q&A',
  'help.faq.headlinePrefix': 'The questions we hear most,',
  'help.faq.headlineFlourish': 'answered honestly.',
  'help.stillStuck': 'Still stuck?',
  'help.stillStuckBody':
    'The fastest way to get unstuck is a 30-minute call. We come prepared. No slides, just answers.',
  'help.bookCall': 'Get my custom plan',
  'help.sendMessage': 'Send a longer message →',
  'help.quickAction.discovery.title': 'Get your custom plan',
  'help.quickAction.discovery.desc':
    'Answer a few questions, then a free 30-minute call',
  'help.quickAction.email.title': 'Email Support',
  'help.quickAction.email.desc': 'hello@flowstarter.net',
  'help.howItWorks': 'How It Works',
  'help.step1.number': '01',
  'help.step1.title': 'We talk',
  'help.step1.description':
    'Answer a few quick questions, then book a free discovery call. We learn about your business, your brand, and your goals',
  'help.step2.number': '02',
  'help.step2.title': 'We build',
  'help.step2.description':
    'Our team designs and builds your site from scratch, tailored to your brand. You review progress along the way',
  'help.step3.number': '03',
  'help.step3.title': 'You own it',
  'help.step3.description':
    'Your site is live. Change text, add a page or tweak the design yourself anytime with the smart editor',
  'help.faq1.question':
    'How long does it take to launch a website with Flowstarter?',
  'help.faq1.answer':
    'We set a realistic timeline together on the discovery call based on scope, then keep you posted the whole way. Relaunches usually move faster since there is less to invent. Most builds ship in weeks, not months, but we will not rush the parts that matter.',
  'help.faq2.question': "What's included in the monthly subscription?",
  'help.faq2.answer':
    'Hosting on EU infrastructure, your domain renewal, SSL, automated backups, ongoing support, and smart editor access. Higher plans unlock more editor capabilities such as manual model selection, code experimentation, and store editing. See the breakdown on the pricing page.',
  'help.faq2.linkLabel': 'See pricing',
  'help.faq3.question': 'Can I edit the site myself after launch?',
  'help.faq3.answer':
    'Yes, that is the whole point. Tell the smart editor something like "change the headline to X" or "add a testimonial from Sarah", and it does it. No software to learn, nobody to wait on.',
  'help.faq4.question': 'Do I own my website? Can I take it elsewhere?',
  'help.faq4.answer':
    'Your domain stays in your name. Your content stays yours. If you ever want to leave, we hand over a static export of the site at no charge. No lock-in, no platform tax.',
  'help.faq4.linkLabel': 'Read the terms',
  'help.faq5.question': 'What happens during the discovery call?',
  'help.faq5.answer':
    '30 minutes, no commitment. We talk about your business, your goals, and what is or is not working today. You ask questions. We tell you honestly if we are the right fit, and if so we agree on a concrete plan and timeline.',
  'help.faq6.question': 'How does pricing work? Are there hidden fees?',
  'help.faq6.answer':
    'A one-time setup fee (20% upfront, 80% on launch) plus a monthly or yearly subscription that covers hosting and the smart editor. Your first month is free on monthly plans. No hidden retainer fees, no per-change pricing, no surprise invoices.',
  'help.faq6.linkLabel': 'See pricing',
  'help.faq7.question': 'Do you handle e-commerce or just brochure sites?',
  'help.faq7.answer':
    'Pro plans include Stripe for digital products, paid bookings, courses and memberships. For a full Shopify-style storefront with inventory, shipping and tax, the Ecommerce tier is open now. Bring it up on the discovery call and we will scope it with you.',
  'help.faq8.question': 'What if I need a change after launch, small or large?',
  'help.faq8.answer':
    'Small changes are instant through the smart editor. Bigger work (new sections, new pages, integrations) gets quoted on a call, usually a small fixed fee rather than a long retainer. Normal upkeep covered by your plan is not charged extra.',
  'help.faq9.question': 'How do I cancel? Is there a contract?',
  'help.faq9.answer':
    'Monthly subscriptions are month-to-month. Cancel any time with 30 days notice by emailing hello@flowstarter.net. Your site stays online through the end of the paid period. We can quote standalone hosting if you want to keep it up afterwards.',
  'help.faq9.linkLabel': 'Cancellation terms',
  'help.faq10.question': 'Where is my site hosted? Is my data safe?',
  'help.faq10.answer':
    'Hosted in the European Union on Hetzner, with daily encrypted backups and TLS everywhere. We use a small, vetted set of subprocessors (Clerk, Supabase, Stripe, Cloudflare) and never sell your data. Full details on our privacy and security pages.',
  'help.faq10.linkLabel': 'Privacy policy',

  // Pricing Page (editorial redesign)
  'pricing.eyebrow': 'Pricing',
  'pricing.headlinePrefix': 'One setup fee.',
  'pricing.headlineFlourish': 'A monthly that earns its keep.',
  'pricing.sub':
    'No retainer games, no charging per change, no invoices you did not see coming. The setup gets you launched and the subscription keeps it running. Custom software builds are quoted on the call, fixed fee.',

  // Cookies Page
  'cookies.badge': 'Transparency First',
  'cookies.title': 'Cookie Policy',
  'cookies.description':
    "We use cookies to make Flowstarter work and to understand how you use it. Here's exactly what we use and why",
  'cookies.lastUpdated': 'Last updated: {date}',
  'cookies.shortVersion.title': 'The Short Version',
  'cookies.shortVersion.essential': 'Essential cookies',
  'cookies.shortVersion.essentialDesc':
    " keep you logged in and the site working. Can't be disabled",
  'cookies.shortVersion.analytics': 'Analytics cookies',
  'cookies.shortVersion.analyticsDesc':
    ' help us improve. Privacy-focused, no personal tracking',
  'cookies.shortVersion.noAds': 'No advertising cookies',
  'cookies.shortVersion.noAdsDesc':
    " We don't serve ads or track you across sites",
  'cookies.shortVersion.control': "You're in control",
  'cookies.shortVersion.controlDesc':
    ' Manage preferences anytime via browser settings',
  'cookies.whatAreCookies.title': 'What Are Cookies?',
  'cookies.whatAreCookies.p1':
    'Cookies are small text files stored on your device when you visit a website. They help websites remember your preferences, keep you logged in, and understand how you use the site',
  'cookies.whatAreCookies.p2':
    "We use cookies to provide you with a better experience on Flowstarter. We don't use cookies to track you across other websites or serve you advertisements",
  'cookies.type.essential.name': 'Essential Cookies',
  'cookies.type.essential.description':
    'These cookies are necessary for the website to function and cannot be switched off. They are usually set in response to actions you take, such as setting your privacy preferences, logging in, or filling in forms',
  'cookies.type.analytics.name': 'Analytics Cookies',
  'cookies.type.analytics.description':
    'These cookies help us understand how visitors interact with our website by collecting and reporting information anonymously. This helps us improve our service',
  'cookies.type.functional.name': 'Functional Cookies',
  'cookies.type.functional.description':
    'These cookies enable enhanced functionality and personalization, such as remembering your preferences and settings',
  'cookies.label.required': 'Required',
  'cookies.label.optional': 'Optional',
  'cookies.table.cookie': 'Cookie',
  'cookies.table.purpose': 'Purpose',
  'cookies.table.duration': 'Duration',
  'cookies.cookie.sessionId.purpose': 'Maintains your login session',
  'cookies.cookie.sessionId.duration': 'Session',
  'cookies.cookie.csrfToken.purpose':
    'Security token to prevent cross-site attacks',
  'cookies.cookie.csrfToken.duration': 'Session',
  'cookies.cookie.cookieConsent.purpose': 'Remembers your cookie preferences',
  'cookies.cookie.cookieConsent.duration': '1 year',
  'cookies.cookie.theme.purpose': 'Remembers your light/dark mode preference',
  'cookies.cookie.theme.duration': '1 year',
  'cookies.cookie.plausible.purpose':
    'Privacy-focused analytics (no personal data)',
  'cookies.cookie.plausible.duration': 'Session',
  'cookies.cookie.language.purpose': 'Remembers your language preference',
  'cookies.cookie.language.duration': '1 year',
  'cookies.cookie.sidebar.purpose': 'Remembers dashboard sidebar state',
  'cookies.cookie.sidebar.duration': '1 year',
  'cookies.thirdParty.title': 'Third-Party Cookies',
  'cookies.thirdParty.description':
    'Some features may involve third-party services that set their own cookies:',
  'cookies.thirdParty.stripe': 'Stripe',
  'cookies.thirdParty.stripeDesc':
    ' (payments) - Sets cookies for fraud prevention and secure checkout',
  'cookies.thirdParty.supabase': 'Supabase',
  'cookies.thirdParty.supabaseDesc':
    ' (authentication) - Sets cookies to maintain your login session',
  'cookies.thirdParty.cloudflare': 'Cloudflare',
  'cookies.thirdParty.cloudflareDesc':
    ' (security) - May set cookies for bot protection and performance',
  'cookies.thirdParty.footer':
    'These providers have their own cookie policies. We only work with trusted, privacy-respecting services',
  'cookies.managing.title': 'Managing Your Cookie Preferences',
  'cookies.managing.description':
    'You can control cookies through your browser settings:',
  'cookies.managing.chrome': 'Chrome:',
  'cookies.managing.chromeDesc':
    ' Settings \u2192 Privacy and Security \u2192 Cookies',
  'cookies.managing.firefox': 'Firefox:',
  'cookies.managing.firefoxDesc':
    ' Settings \u2192 Privacy & Security \u2192 Cookies',
  'cookies.managing.safari': 'Safari:',
  'cookies.managing.safariDesc': ' Preferences \u2192 Privacy \u2192 Cookies',
  'cookies.managing.edge': 'Edge:',
  'cookies.managing.edgeDesc': ' Settings \u2192 Cookies and Site Permissions',
  'cookies.managing.warning':
    'Note: Blocking essential cookies may prevent you from using Flowstarter properly',
  'cookies.changes.title': 'Changes to This Policy',
  'cookies.changes.description':
    "We may update this Cookie Policy from time to time. We'll notify you of significant changes by updating the date at the top of this page. For major changes, we may also show you a new consent banner",
  'cookies.contact.title': 'Questions about cookies?',
  'cookies.contact.description': 'Read our full {link} or contact us',
  'cookies.contact.privacyLink': 'Privacy Policy',

  // Privacy Page
  'privacy.badge': 'GDPR Compliant',
  'privacy.title': 'Privacy Policy',
  'privacy.description':
    'We respect your privacy and are committed to protecting your personal data. This policy explains how we collect, use, and safeguard your information',
  'privacy.effective': 'Effective: {date}',
  'privacy.lastUpdated': 'Last updated: {date}',
  'privacy.glance.title': 'Privacy at a Glance',
  'privacy.glance.dataProtected.title': 'Your data is protected',
  'privacy.glance.dataProtected.desc':
    'Enterprise-grade encryption, secure infrastructure, strict access controls',
  'privacy.glance.aiTransparent.title': 'AI is transparent',
  'privacy.glance.aiTransparent.desc':
    'We tell you exactly what data goes to AI providers and how',
  'privacy.glance.ownContent.title': 'You own your content',
  'privacy.glance.ownContent.desc':
    'Download your assets anytime. Your content is never used for AI training without consent',
  'privacy.glance.noTracking.title': 'No tracking for ads',
  'privacy.glance.noTracking.desc':
    'We use privacy-focused analytics. No advertising cookies. We never sell your data',
  'privacy.glance.retention.title': 'You control retention',
  'privacy.glance.retention.desc':
    'Request deletion anytime. We keep data only as long as needed',
  'privacy.glance.gdpr.title': 'GDPR compliant',
  'privacy.glance.gdpr.desc':
    'Full data subject rights. EU-based company with proper safeguards',
  'privacy.contents': 'Contents',
  'privacy.aiNotice.title': 'Important: AI & Your Data',
  'privacy.aiNotice.description':
    'Flowstarter uses AI technology. We want to be completely transparent:',
  'privacy.aiNotice.item1':
    'Your prompts are processed by third-party AI providers (Anthropic)',
  'privacy.aiNotice.item2':
    'We may use anonymized patterns to improve our AI (not your content)',
  'privacy.aiNotice.item3':
    'We will NEVER use your personal content for AI training without consent',
  'privacy.aiNotice.item4': 'You can opt out of anonymized data collection',
  'privacy.aiNotice.footer': 'See Sections 5 and 6 for full details',
  'privacy.s1.title': '1. Who We Are',
  'privacy.s1.c1.subtitle': '1.1 About Flowstarter',
  'privacy.s1.c1.text':
    'Flowstarter is a website building service operated from Romania, European Union. We design and build professional websites for coaches, consultants, therapists, and small businesses. After launch, clients can update their sites using our AI-powered editor. Our registered address and company details are available upon request',
  'privacy.s1.c2.subtitle': '1.2 Data Controller',
  'privacy.s1.c2.text':
    'Flowstarter acts as the Data Controller for the personal data we collect from our clients (you). This means we determine the purposes and means of processing your personal data',
  'privacy.s1.c3.subtitle': '1.3 Contact for Privacy Matters',
  'privacy.s1.c3.text':
    'For any privacy-related questions, concerns, or to exercise your data rights, contact us at: {email}. We aim to respond to all privacy inquiries within 48 hours and will address formal requests within 30 days as required by GDPR',
  'privacy.s2.title': '2. Lawful Basis for Processing',
  'privacy.s2.c1.subtitle': '2.1 Contract Performance',
  'privacy.s2.c1.text':
    'We process your data to fulfill our contract with you: building your website, providing dashboard access, hosting your site, and delivering the services you paid for. This includes processing your business information, content, and project data',
  'privacy.s2.c2.subtitle': '2.2 Legitimate Interest',
  'privacy.s2.c2.text':
    'We process certain data based on our legitimate business interests, including: improving our platform and AI systems using anonymized/aggregated data, preventing fraud and ensuring security, and communicating service updates. We balance these interests against your rights and only proceed where our interests do not override yours',
  'privacy.s2.c3.subtitle': '2.3 Consent',
  'privacy.s2.c3.text':
    'Where required, we obtain your explicit consent before processing. This includes: marketing communications, use of non-essential cookies, and any use of identifiable content for AI training (which we do not do without asking). You can withdraw consent at any time',
  'privacy.s2.c4.subtitle': '2.4 Legal Obligation',
  'privacy.s2.c4.text':
    'We retain certain data (e.g., invoices, payment records) to comply with tax, accounting, and other legal requirements',
  'privacy.s3.title': '3. Information We Collect',
  'privacy.s3.c1.subtitle': '3.1 Discovery Call & Onboarding Data',
  'privacy.s3.c1.text':
    'When you book a discovery call, we collect: business name, industry/niche, branding preferences (colors, fonts, tone of voice), content you provide (text, images, logos), contact information (name, email, phone), target audience description, and competitor references',
  'privacy.s3.c2.subtitle': '3.2 Account & Platform Data',
  'privacy.s3.c2.text':
    'When using our platform: account credentials (email, name, authentication method), project data (site structure, pages, components, design choices), AI editor interactions (prompts, edits, customization history), and platform usage data (features used, session information).',
  'privacy.s3.c3.subtitle': '3.3 Payment Information',
  'privacy.s3.c3.text':
    'Payments are processed by Stripe. We receive confirmation of payment, subscription status, and billing history. We do NOT store credit card numbers, CVVs, or full payment credentials on our servers. Stripe handles all sensitive payment data under PCI-DSS compliance',
  'privacy.s3.c4.subtitle': '3.4 Automatically Collected Data',
  'privacy.s3.c4.text':
    'We automatically collect: IP address (anonymized for analytics), browser type and version, device type and operating system, pages visited and time spent, referral source, and general geographic region (country/city level).',
  'privacy.s4.title': '4. How We Use Your Information',
  'privacy.s4.c1.subtitle': '4.1 Service Delivery',
  'privacy.s4.c1.text':
    'Primary uses: building and hosting your website, providing dashboard and editor access, enabling AI-powered editing features, processing payments and managing subscriptions, and providing customer support',
  'privacy.s4.c2.subtitle': '4.2 Communication',
  'privacy.s4.c2.text':
    'We contact you for: service notifications and important updates, project progress and deliverables, security alerts, and marketing (only with consent, easy opt-out).',
  'privacy.s4.c3.subtitle': '4.3 Platform Improvement',
  'privacy.s4.c3.text':
    'We use aggregated, anonymized data to: improve platform performance and features, fix bugs and issues, understand usage patterns, and develop new features',
  'privacy.s4.c4.subtitle': '4.4 Security & Fraud Prevention',
  'privacy.s4.c4.text':
    'We process data to: detect and prevent fraud, protect against unauthorized access, ensure platform integrity, and comply with legal requirements',
  'privacy.s5.title': '5. AI Technology & Data Processing',
  'privacy.s5.c1.subtitle': '5.1 How We Use AI',
  'privacy.s5.c1.text':
    'Flowstarter uses AI technology for: generating website code and components, powering the AI editor for content changes, providing design suggestions, and automating repetitive development tasks. When you use AI features, data is sent to AI providers for real-time processing',
  'privacy.s5.c2.subtitle': '5.2 Third-Party AI Providers',
  'privacy.s5.c2.text':
    'We currently use Anthropic (Claude) for AI processing. We may integrate additional providers in the future. These providers process data under their own privacy policies and our data processing agreements (DPAs). They are contractually prohibited from using your data for their own training purposes',
  'privacy.s5.c3.subtitle': '5.3 What Data Goes to AI Providers',
  'privacy.s5.c3.text':
    'When you use AI features, we send: your prompts and instructions, relevant page/component context needed for the task, and design preferences. We minimize data transmission to only what is necessary. We do NOT send: your personal contact information, payment details, or unrelated project data',
  'privacy.s5.c4.subtitle': '5.4 AI Compute Infrastructure',
  'privacy.s5.c4.text':
    'We use Daytona cloud workspaces for AI code execution. Code is executed in isolated, secure environments. No persistent storage of your data occurs on compute infrastructure beyond the active session',
  'privacy.s6.title': '6. Anonymized Data for AI Improvement',
  'privacy.s6.c1.subtitle': '6.1 What We May Use (Anonymized Only)',
  'privacy.s6.c1.text':
    'We may use anonymized, aggregated data to improve our AI systems: website structure patterns by industry, common editing workflows, prompt effectiveness patterns (anonymized), template usage statistics, and design preference trends. This data cannot be traced back to you or your business',
  'privacy.s6.c2.subtitle':
    '6.2 What We Will NEVER Use Without Explicit Consent',
  'privacy.s6.c2.text':
    'We will never use for AI training: your business name, branding, or identifiable content, your images, logos, or creative assets, your personal information, individual project data in identifiable form, or any data that could identify you or your clients',
  'privacy.s6.c3.subtitle': '6.3 Opt-Out Rights',
  'privacy.s6.c3.text':
    'You can opt out of anonymized data collection for AI improvement by emailing {email}. Opting out will not affect your service but may limit certain AI features that rely on aggregated learning. Opt-out requests are processed within 30 days',
  'privacy.s6.c4.subtitle': '6.4 Future AI Development',
  'privacy.s6.c4.text':
    'We may develop proprietary AI models using aggregated platform data. Any such development will follow these principles: strict anonymization, no identifiable content, transparency about methods, and continued opt-out availability',
  'privacy.s7.title': '7. Data Sharing & Third Parties',
  'privacy.s7.c1.subtitle': '7.1 Service Providers',
  'privacy.s7.c1.text':
    'We share data with trusted providers who help us operate: Stripe (payment processing), Supabase (database, authentication), Cloudflare (hosting, CDN, security), AWS S3 (asset storage), Anthropic (AI processing), Daytona (compute infrastructure), Convex (real-time editor data), and Analytics provider (Plausible or PostHog, privacy-focused).',
  'privacy.s7.c2.subtitle': '7.2 Authentication Providers',
  'privacy.s7.c2.text':
    'If you sign in via Google, GitHub, Apple, or Facebook, we receive basic profile data (name, email) from these providers. We do not receive your passwords. Each provider has its own privacy policy governing their data practices',
  'privacy.s7.c3.subtitle': '7.3 Legal Requirements',
  'privacy.s7.c3.text':
    'We may disclose data if required by law, court order, or government request. We will notify you unless legally prohibited',
  'privacy.s7.c4.subtitle': '7.4 Business Transfers',
  'privacy.s7.c4.text':
    'If Flowstarter is acquired or merged, your data may transfer to the new entity. We will notify you before any such transfer and your rights under this policy will continue',
  'privacy.s7.c5.subtitle': '7.5 No Data Sales',
  'privacy.s7.c5.text':
    'We do NOT sell your personal information to anyone. We do NOT share data with advertisers. Your data is used solely to provide and improve our service',
  'privacy.s8.title': '8. Client Websites & End Users',
  'privacy.s8.c1.subtitle': '8.1 Our Role',
  'privacy.s8.c1.text':
    'When we host your website, we act as a Data Processor on your behalf. You (our client) are the Data Controller for any data your website collects from your visitors',
  'privacy.s8.c2.subtitle': '8.2 Your Responsibilities',
  'privacy.s8.c2.text':
    'You are responsible for: having your own privacy policy for your website, obtaining necessary consents from your visitors, complying with applicable privacy laws for your audience, and configuring any forms or data collection appropriately',
  'privacy.s8.c3.subtitle': '8.3 What We Collect from Hosted Sites',
  'privacy.s8.c3.text':
    'We collect minimal technical data from visitors to sites we host: aggregated traffic statistics (page views, visitor counts), server logs for security and performance (IP addresses retained for 30 days), and error logs for debugging. We do NOT access or process personal data submitted to your website (form submissions, customer data) except as necessary for hosting',
  'privacy.s8.c4.subtitle': '8.4 Data Processing Agreement',
  'privacy.s8.c4.text':
    'Enterprise clients may request a formal Data Processing Agreement (DPA) for their hosted websites. Contact us to arrange this',
  'privacy.s9.title': '9. Data Security',
  'privacy.s9.c1.subtitle': '9.1 Encryption',
  'privacy.s9.c1.text':
    'All data in transit is encrypted using TLS 1.3. Data at rest is encrypted using AES-256. Database connections use encrypted channels. Payment data is handled entirely by PCI-DSS compliant Stripe',
  'privacy.s9.c2.subtitle': '9.2 Access Controls',
  'privacy.s9.c2.text':
    'Strict role-based access controls limit who can access data. All access is logged and auditable. Employees with data access undergo background checks and security training. Multi-factor authentication required for all internal systems',
  'privacy.s9.c3.subtitle': '9.3 Infrastructure Security',
  'privacy.s9.c3.text':
    'We use SOC 2 compliant infrastructure providers. Regular security assessments and penetration testing. Automated vulnerability scanning. DDoS protection via Cloudflare',
  'privacy.s9.c4.subtitle': '9.4 Incident Response',
  'privacy.s9.c4.text':
    'We maintain an incident response plan. In case of a data breach affecting your personal data, we will: notify affected users within 72 hours, notify relevant supervisory authorities as required, document the breach and remediation steps, and take immediate action to contain and resolve the incident',
  'privacy.s10.title': '10. Your Rights (GDPR)',
  'privacy.s10.c1.subtitle': '10.1 Right to Access',
  'privacy.s10.c1.text':
    'You can request a copy of all personal data we hold about you. We will provide this in a commonly used electronic format within 30 days',
  'privacy.s10.c2.subtitle': '10.2 Right to Rectification',
  'privacy.s10.c2.text':
    'You can correct inaccurate personal data through your account settings or by contacting us',
  'privacy.s10.c3.subtitle': '10.3 Right to Erasure ("Right to be Forgotten")',
  'privacy.s10.c3.text':
    'You can request deletion of your personal data. We will comply within 30 days, except for data we must retain for legal purposes (e.g., invoices).',
  'privacy.s10.c4.subtitle': '10.4 Right to Data Portability',
  'privacy.s10.c4.text':
    'You can download your website files, assets, and content at any time. You own your content. We provide data export in standard formats',
  'privacy.s10.c5.subtitle': '10.5 Right to Object',
  'privacy.s10.c5.text':
    'You can object to processing based on legitimate interest, including anonymized data collection for AI improvement',
  'privacy.s10.c6.subtitle': '10.6 Right to Restrict Processing',
  'privacy.s10.c6.text':
    'You can request we limit how we use your data while a complaint or request is being resolved',
  'privacy.s10.c7.subtitle': '10.7 Right to Withdraw Consent',
  'privacy.s10.c7.text':
    'Where we process data based on consent, you can withdraw that consent anytime. This does not affect the lawfulness of prior processing',
  'privacy.s10.c8.subtitle': '10.8 Right to Lodge a Complaint',
  'privacy.s10.c8.text':
    'You have the right to lodge a complaint with your local data protection authority. In Romania, this is ANSPDCP (Autoritatea Na\u021Bional\u0103 de Supraveghere a Prelucr\u0103rii Datelor cu Caracter Personal).',
  'privacy.s10.c9.subtitle': '10.9 Exercising Your Rights',
  'privacy.s10.c9.text':
    'To exercise any of these rights, email {email} with your request. We may need to verify your identity before processing. We respond to all requests within 30 days',
  'privacy.s11.title': '11. Data Retention',
  'privacy.s11.c1.subtitle': '11.1 Active Subscriptions',
  'privacy.s11.c1.text':
    'While your subscription is active, we retain all data necessary to provide the service: account information, project data, and usage history',
  'privacy.s11.c2.subtitle': '11.2 After Cancellation',
  'privacy.s11.c2.text':
    'When you cancel: project data and website files are retained for 90 days (in case you reactivate), after 90 days, project data is permanently deleted, account information is retained for 30 days then deleted',
  'privacy.s11.c3.subtitle': '11.3 Upon Account Deletion Request',
  'privacy.s11.c3.text':
    'When you request account deletion: personal data deleted within 30 days, anonymized/aggregated data may be retained indefinitely (it cannot identify you), and backup copies purged within 90 days',
  'privacy.s11.c4.subtitle': '11.4 Legal Retention',
  'privacy.s11.c4.text':
    'Certain data retained as legally required: invoices and payment records (7 years for tax purposes), data relevant to disputes (until resolution), and data subject to legal holds',
  'privacy.s11.c5.subtitle': '11.5 Anonymized Data',
  'privacy.s11.c5.text':
    'Truly anonymized, aggregated data (which cannot identify any individual) may be retained indefinitely for analytics and AI improvement purposes',
  'privacy.s12.title': '12. International Data Transfers',
  'privacy.s12.c1.subtitle': '12.1 Where Data Is Processed',
  'privacy.s12.c1.text':
    'Your data may be processed in: European Union (primary), United States (some infrastructure providers, AI processing).',
  'privacy.s12.c2.subtitle': '12.2 Safeguards for US Transfers',
  'privacy.s12.c2.text':
    'For transfers to the US, we rely on: Standard Contractual Clauses (SCCs) with providers, EU-US Data Privacy Framework certification where applicable, and provider-specific security commitments',
  'privacy.s12.c3.subtitle': '12.3 Provider Locations',
  'privacy.s12.c3.text':
    'Supabase: US and EU regions available. Cloudflare: Global CDN with EU presence. AWS S3: EU region (eu-central-1). Anthropic: US-based processing. Stripe: Global with EU entity',
  'privacy.s13.title': '13. Cookies & Tracking',
  'privacy.s13.c1.subtitle': '13.1 Essential Cookies',
  'privacy.s13.c1.text':
    'Required for the service to function: authentication/session cookies, security tokens, and preference cookies (theme, language). These cannot be disabled',
  'privacy.s13.c2.subtitle': '13.2 Analytics Cookies',
  'privacy.s13.c2.text':
    'We use privacy-focused analytics (Plausible or PostHog) to understand platform usage. These do not track you across other sites and can be blocked via browser settings',
  'privacy.s13.c3.subtitle': '13.3 No Advertising Cookies',
  'privacy.s13.c3.text':
    'We do NOT use advertising or tracking cookies. We do NOT participate in ad networks. We do NOT build advertising profiles',
  'privacy.s13.c4.subtitle': '13.4 Managing Cookies',
  'privacy.s13.c4.text':
    'Most browsers allow you to manage cookie preferences. Blocking essential cookies may prevent you from using the service',
  'privacy.s14.title': "14. Children's Privacy",
  'privacy.s14.c1.subtitle': '14.1 Age Requirement',
  'privacy.s14.c1.text':
    'Flowstarter is intended for users aged 18 and older. We do not knowingly collect personal data from anyone under 18',
  'privacy.s14.c2.subtitle': '14.2 Parental Notice',
  'privacy.s14.c2.text':
    'If we learn we have collected data from someone under 18, we will delete it promptly. If you believe a minor has provided us data, please contact {email}.',
  'privacy.s15.title': '15. Changes to This Policy',
  'privacy.s15.c1.subtitle': '15.1 Updates',
  'privacy.s15.c1.text':
    'We may update this policy to reflect changes in our practices, technology, legal requirements, or business operations',
  'privacy.s15.c2.subtitle': '15.2 Notification',
  'privacy.s15.c2.text':
    'For significant changes, we will: email registered users, display a notice on the platform, and update the "Last Updated" date. Continued use after changes indicates acceptance',
  'privacy.s15.c3.subtitle': '15.3 Review',
  'privacy.s15.c3.text':
    'We encourage periodic review of this policy. Material changes will be highlighted',
  'privacy.s16.title': '16. Contact Us',
  'privacy.s16.c1.subtitle': '16.1 Privacy Inquiries',
  'privacy.s16.c1.text':
    'For privacy-specific questions, data requests, or to exercise your rights: {email}',
  'privacy.s16.c2.subtitle': '16.2 General Support',
  'privacy.s16.c2.text': 'For general questions about our service: {email}',
  'privacy.s16.c3.subtitle': '16.3 Response Time',
  'privacy.s16.c3.text':
    'We aim to respond to privacy inquiries within 48 hours. Formal data subject requests will be completed within 30 days',
  'privacy.termsRef':
    'This Privacy Policy should be read alongside our {link}, which governs your use of Flowstarter',
  'privacy.termsRefLink': 'Terms of Service',
  'privacy.contact.title': 'Questions about your privacy?',
  'privacy.contact.description': "We're here to help. Reach out anytime",

  // Terms Page
  'terms.badge': 'Legal Agreement',
  'terms.title': 'Terms of Service',
  'terms.description':
    'By using Flowstarter, you agree to these terms. Please read them carefully',
  'terms.lastUpdated': 'Last updated: {date}',
  'terms.summary.pricing.title': 'Simple Pricing',
  'terms.summary.pricing.desc': 'Setup fee + monthly subscription',
  'terms.summary.content.title': 'Your Content',
  'terms.summary.content.desc': 'You own what you create',
  'terms.summary.cancel.title': 'Cancel Anytime',
  'terms.summary.cancel.desc': 'No lock-in contracts',
  'terms.s1.title': 'Agreement to Terms',
  'terms.s1.i1.subtitle': 'Acceptance',
  'terms.s1.i1.text':
    'By accessing or using Flowstarter, you agree to be bound by these Terms of Service. If you disagree with any part of the terms, you may not access the service',
  'terms.s1.i2.subtitle': 'Eligibility',
  'terms.s1.i2.text':
    'You must be at least 18 years old to use our services. By using Flowstarter, you represent that you meet this requirement',
  'terms.s1.i3.subtitle': 'Account Responsibility',
  'terms.s1.i3.text':
    'You are responsible for maintaining the confidentiality of your account and password. You agree to accept responsibility for all activities that occur under your account',
  'terms.s2.title': 'Our Services',
  'terms.s2.i1.subtitle': 'Website Building',
  'terms.s2.i1.text':
    'Flowstarter provides website design, development, and hosting services. Our team builds your website based on a discovery call, and after launch you can customize it using our AI editor',
  'terms.s2.i2.subtitle': 'Hosting and Email',
  'terms.s2.i2.text':
    'Your subscription includes website hosting, SSL certificate, and professional email. These are provided as part of your monthly plan',
  'terms.s2.i3.subtitle': 'Service Availability',
  'terms.s2.i3.text':
    'We strive for 99.9% uptime but cannot guarantee uninterrupted service. We will notify you of planned maintenance when possible',
  'terms.s3.title': 'Payments and Billing',
  'terms.s3.i1.subtitle': 'Setup Fee',
  'terms.s3.i1.text':
    'A one-time setup fee is charged for the initial website build. 20% is due upfront to start the project (non-refundable deposit), and 80% is due upon your approval of the final site. This covers the discovery call, design, development, and domain/email setup',
  'terms.s3.i2.subtitle': 'Monthly Subscription',
  'terms.s3.i2.text':
    'Your first month is free. After that, your subscription is billed monthly. You can cancel anytime, and your site will remain active until the end of your billing period',
  'terms.s3.i3.subtitle': 'AI Assistant Usage',
  'terms.s3.i3.text':
    'Your plan includes access to the AI editor for site customization. Claude Code manages token and usage limits directly',
  'terms.s3.i4.subtitle': 'Price Changes',
  'terms.s3.i4.text':
    'We may change our prices with 30 days notice. Early adopter pricing is locked for the duration of your subscription, as long as it remains active',
  'terms.s4.title': 'Your Content',
  'terms.s4.i1.subtitle': 'Ownership',
  'terms.s4.i1.text':
    'You retain all rights to the content you create and upload to your website. You can download your site assets at any time',
  'terms.s4.i2.subtitle': 'License to Us',
  'terms.s4.i2.text':
    'You grant us a license to host, display, and transmit your content as necessary to provide our services. This license ends when you delete your content or close your account',
  'terms.s4.i3.subtitle': 'Prohibited Content',
  'terms.s4.i3.text':
    "You may not use our service to host illegal content, malware, spam, or content that infringes on others' intellectual property rights",
  'terms.s5.title': 'Intellectual Property',
  'terms.s5.i1.subtitle': 'Our Platform',
  'terms.s5.i1.text':
    'Flowstarter, our logo, and our platform are protected by intellectual property laws. You may not copy, modify, or distribute our software or branding',
  'terms.s5.i2.subtitle': 'Templates',
  'terms.s5.i2.text':
    'Our website templates are licensed for use within Flowstarter. You may not extract, resell, or redistribute template code',
  'terms.s6.title': 'Termination',
  'terms.s6.i1.subtitle': 'By You',
  'terms.s6.i1.text':
    'You can cancel your subscription at any time from your account settings. Your site will remain active until the end of your current billing period',
  'terms.s6.i2.subtitle': 'By Us',
  'terms.s6.i2.text':
    'We may suspend or terminate your account if you violate these terms, engage in fraudulent activity, or fail to pay for services',
  'terms.s6.i3.subtitle': 'Effect of Termination',
  'terms.s6.i3.text':
    'Upon termination, you can download your site assets for 90 days. After that, your data will be deleted',
  'terms.s7.title': 'Limitation of Liability',
  'terms.s7.i1.subtitle': 'No Warranty',
  'terms.s7.i1.text':
    'Our services are provided "as is" without warranties of any kind. We do not guarantee that our service will meet your specific requirements',
  'terms.s7.i2.subtitle': 'Liability Cap',
  'terms.s7.i2.text':
    'Our total liability to you for any claims arising from our services is limited to the amount you paid us in the 12 months before the claim',
  'terms.s8.title': 'Changes to Terms',
  'terms.s8.i1.subtitle': 'Updates',
  'terms.s8.i1.text':
    'We may update these terms from time to time. We will notify you of significant changes via email or through our platform',
  'terms.s8.i2.subtitle': 'Continued Use',
  'terms.s8.i2.text':
    'Your continued use of Flowstarter after changes to the terms constitutes acceptance of the new terms',
  'terms.contact.title': 'Questions about our terms?',
  'terms.contact.description': "We're happy to clarify anything",

  // Common labels
  'app.close': 'Close',
  'app.draft': 'Draft',
  'app.untitled': 'Untitled',
  'app.untitledProject': 'Untitled Project',
  'app.unknownProject': 'Unknown Project',
  'app.userFallback': 'User',
  'app.yourProfile': 'Your Profile',
  'app.noPreviewAvailable': 'No preview available',
  'app.somethingWentWrong': 'Something went wrong',
  'app.failedToUpdatePhoto': 'Failed to update photo',
  'app.projectLabel': 'Project',
  'app.chatPlaceholder': 'Describe what you want to build...',

  // Landing hero

  // Team pages
  'team.domains.clientDomain': 'Client Domain',
  'team.email.clientDomain': 'Client Domain',
  'team.services.noIntegrations': 'No integrations configured yet',
  'team.services.selectProject': 'Select a project',
  'team.services.enterApiKey': 'Enter your API key',
  'team.services.failedToSave': 'Failed to save integration',
  'team.join.invalidInvitation': 'Invalid invitation',
  'team.join.passwordPlaceholder': 'At least 8 characters',
  'team.join.repeatPassword': 'Repeat your password',
  'team.dashboard.namePlaceholder': 'John Smith',
  'team.invite.failedToSend': 'Failed to send invitation',
  'team.login.invalidCredentials':
    'Incorrect email or password. Try again, or reset your password',

  // Scaffold - Quick Draft Generator
  'scaffold.client.title': 'Client Details',
  'scaffold.client.subtitle': 'Who is this project for?',
  'scaffold.client.field.name': 'Client Name',
  'scaffold.client.field.email': 'Client Email',
  'scaffold.client.field.phone': 'Client Phone',
  'scaffold.client.field.businessName': 'Business Name',
  'scaffold.client.placeholder.name': 'John Smith',
  'scaffold.client.placeholder.email': 'john@example.com',
  'scaffold.client.placeholder.phone': '+40 7XX XXX XXX',
  'scaffold.client.error.name': 'Name must be at least 2 characters',
  'scaffold.client.error.email': 'Please enter a valid email address',
  'scaffold.client.error.phone': 'Please enter a valid phone number',
  'scaffold.collapsed.prompt': 'Describe a business to generate a draft',
  'scaffold.input.title': 'AI Draft Generator',
  'scaffold.input.subtitle':
    'Describe the business in detail, AI builds the project brief',
  'scaffold.input.placeholder': "Describe your client's business in detail...",
  'scaffold.input.chip.services': 'Services & pricing',
  'scaffold.input.chip.location': 'Location',
  'scaffold.input.chip.clients': 'Target clients',
  'scaffold.input.chip.style': 'Brand style',
  'scaffold.input.moreDetail': 'Add more detail for better results',
  'scaffold.input.charCount': '{count} chars',
  'scaffold.input.analyzing': 'Analyzing...',
  'scaffold.input.generate': 'Generate Brief',
  'scaffold.input.hint':
    'The more detail you provide, the better the AI-generated brief',
  'scaffold.input.attachFiles': 'Attach files',
  'scaffold.progress.title': 'AI is analyzing...',
  'scaffold.progress.subtitle': 'Building your project brief',
  'scaffold.progress.step1': 'Reading business description...',
  'scaffold.progress.step2': 'Identifying industry & audience...',
  'scaffold.progress.step3': 'Crafting value proposition...',
  'scaffold.progress.step4': 'Generating project brief...',
  'scaffold.clarify.title': 'A few more details',
  'scaffold.clarify.subtitle': 'Help the AI build a more accurate brief',
  'scaffold.clarify.placeholder': 'Your answer...',
  'scaffold.clarify.hint': 'Answer what you can, skip the rest',
  'scaffold.review.step1.title': 'Business Identity',
  'scaffold.review.step1.subtitle': 'Core business information',
  'scaffold.review.step2.title': 'Positioning',
  'scaffold.review.step2.subtitle': 'Target market and brand',
  'scaffold.review.step3.title': 'Offerings & Goals',
  'scaffold.review.step3.subtitle': 'Services, pricing, and objectives',
  'scaffold.review.step4.title': 'Contact Details',
  'scaffold.review.step4.subtitle': 'How clients reach the business',
  'scaffold.review.field.siteName': 'Site Name',
  'scaffold.review.field.industry': 'Industry',
  'scaffold.review.field.description': 'Description',
  'scaffold.review.field.targetAudience': 'Target Audience',
  'scaffold.review.field.uvp': 'Value Proposition',
  'scaffold.review.field.brandTone': 'Brand Tone',
  'scaffold.review.field.offerings': 'Services / Packages',
  'scaffold.review.field.goal': 'Primary Goal',
  'scaffold.review.field.offerType': 'Pricing Tier',
  'scaffold.review.field.contactEmail': 'Email',
  'scaffold.review.field.contactPhone': 'Phone',
  'scaffold.review.field.contactAddress': 'Address',
  'scaffold.review.placeholder.siteName': 'e.g. Smile Dental',
  'scaffold.review.placeholder.industry': 'e.g. dental, beauty-salon, legal',
  'scaffold.review.placeholder.description': 'What does this business do?',
  'scaffold.review.placeholder.targetAudience': 'Who are their ideal clients?',
  'scaffold.review.placeholder.uvp': 'What makes them stand out?',
  'scaffold.review.placeholder.brandTone': 'professional, bold, or friendly',
  'scaffold.review.placeholder.offerings':
    'e.g. Consultation - \u20ac50, Premium Package - \u20ac200/mo',
  'scaffold.review.placeholder.goal': 'leads, sales, or bookings',
  'scaffold.review.placeholder.offerType': 'premium, accessible, or free',
  'scaffold.review.placeholder.contactEmail': 'hello@business.com',
  'scaffold.review.placeholder.contactPhone': '+40 7XX XXX XXX',
  'scaffold.review.placeholder.contactAddress': 'Street, City, Country',
  'scaffold.review.regenerate': 'Regenerate with AI',
  'scaffold.review.stepCounter': 'Step {current} of {total}',
  'scaffold.action.startOver': 'Start Over',
  'scaffold.action.back': 'Back',
  'scaffold.action.next': 'Next',
  'scaffold.action.continue': 'Continue',
  'scaffold.action.openInEditor': 'Open in Editor',

  // Manifesto

  // Storage promise (shared across hero, included, pricing)

  // Landing Hero — editorial redesign
  'landing.hero.displayPrefix': 'Your business already has a brand.',
  'landing.hero.displayFlourish': 'We turn it into a website.',
  'landing.hero.proofLine': 'A tailored preview, before you pay.',
  'landing.hero.subhead':
    'Share your details and public profiles. Our agent picks the right starting design and creates a preview shaped around you.',
  'landing.hero.primaryCta': 'Build my site',
  'landing.hero.secondaryCta': 'See the process',
  'landing.hero.eyebrowSerial':
    'Agents build your site. Our team keeps it true to you.',
  'landing.hero.eyebrowLabel': '',
  'landing.hero.eyebrowTagline': '',
  'landing.hero.guaranteeShort':
    'Preview first. Pay 20% only when the direction feels right.',
  'landing.hero.stat1Value': 'Fast',
  'landing.hero.stat1Label': 'Loads quickly',
  'landing.hero.stat2Value': 'Yours',
  'landing.hero.stat2Label': 'No lock-in',
  'landing.hero.stat3Value': 'Visible',
  'landing.hero.stat3Label': 'Ready for search',
  'landing.hero.stat4Value': 'Simple',
  'landing.hero.stat4Label': 'Just ask for edits',
  'landing.hero.brief.live': 'Ready to review',
  'landing.hero.brief.liveWorking': 'Agents at work',
  'landing.hero.brief.serial': 'Your preview',
  'landing.hero.brief.title': 'Your site, taking shape',
  'landing.hero.brief.subtitle': 'Built around your real business',
  'landing.hero.brief.field1Label': 'What you share',
  'landing.hero.brief.field1Value': 'Business details and public profiles',
  'landing.hero.brief.field2Label': 'Your style',
  'landing.hero.brief.field2Value': 'How it should sound, look and feel',
  'landing.hero.brief.field3Label': 'Starting design',
  'landing.hero.brief.field3Value': 'Best starting design for your business',
  'landing.hero.brief.field4Label': 'Personal touch',
  'landing.hero.brief.field4Value': 'Your words, images and customer journey',
  'landing.hero.brief.scenario2.field1Value': 'A neighborhood bistro in Lisbon',
  'landing.hero.brief.scenario2.field2Value':
    'Custom site with menu and bookings',
  'landing.hero.brief.scenario3.field1Value':
    'A salon and barber duo in Cluj-Napoca',
  'landing.hero.brief.scenario3.field2Value':
    'Booking site with stylist profiles',
  'landing.hero.brief.scenario4.field1Value':
    'An independent boutique selling local crafts',
  'landing.hero.brief.scenario4.field2Value': 'Online store with checkout',
  'landing.hero.brief.progressLabel': 'Status',
  'landing.hero.brief.progressBuilding': 'Building',
  'landing.hero.brief.progressLearning': 'Learning your business',
  'landing.hero.brief.progressVoice': 'Shaping your voice',
  'landing.hero.brief.progressDesign': 'Choosing your design',
  'landing.hero.brief.progressReady': 'Preview ready',
  'landing.hero.brief.ctaPending': 'Get my site built',
  'landing.hero.brief.ctaReady': 'Build my site',
  'landing.hero.pills.label': 'Included from day one',
  'landing.hero.pills.booking': 'Cal.com booking',
  'landing.hero.pills.newsletter': 'Newsletter',
  'landing.hero.pills.leads': 'Leads form',
  'landing.hero.pills.edit': 'Edit on demand',

  // Templates — editorial redesign

  // Editor showcase — editorial redesign
  'landing.editorShowcase.eyebrow': "After launch, it's yours to change",
  'landing.editorShowcase.headlinePrefix': 'Change it yourself.',
  'landing.editorShowcase.headlineFlourish': 'Just ask, in plain words.',
  'landing.editorShowcase.sub':
    'Click the exact text you want to improve and ask for the change in plain words. Bigger visual or structural work goes straight to the team caring for your site.',

  // Problem — editorial redesign
  'landing.problem.eyebrow': "What you've tried so far",
  'landing.problem.headlinePrefix': 'You know how',
  'landing.problem.headlineFlourish': 'this usually goes',
  'landing.problem.sub':
    'Traditional methods all run into the same problems. None of them hold up when a customer is comparing you to someone else.',

  // Pillars — editorial redesign

  // Included — editorial redesign
  'landing.included.eyebrow': "What's in Starter (€799 + €49/mo)",
  'landing.included.headlinePrefix': 'A real site,',
  'landing.included.headlineFlourish': 'wired up before launch',
  'landing.included.sub':
    'Cal.com booking, your newsletter, a lead form and your editor, all set up in your own name. The subscription covers the editor, maintenance and support. Cancel and the site still runs',
  'landing.included.ownership.title': 'It is all yours from day one',
  'landing.included.ownership.body':
    'We set everything up in your name, never ours. The site, content and web address belong to you. Cancel the subscription whenever you want and you can keep the site running without us',
  'landing.included.ownership.chip1Label': 'Site',
  'landing.included.ownership.chip1Value': 'Yours',
  'landing.included.ownership.chip2Label': 'Content',
  'landing.included.ownership.chip2Value': 'Yours',
  'landing.included.ownership.chip3Label': 'Hosting',
  'landing.included.ownership.chip3Value': 'Yours',

  // Differentiation — editorial redesign
  'landing.differentiation.eyebrow': 'Why us',
  'landing.differentiation.headlinePrefix': 'Your agent team works 24/7.',
  'landing.differentiation.headlineFlourish': 'Our human team signs off.',
  'landing.team.headlinePrefix': 'A team of specialists,',
  'landing.team.headlineFlourish': 'and two people who answer for it.',
  'landing.team.sub':
    'Each agent does one job and hands on. Nothing reaches you until both of us have looked at it.',
  'landing.team.agentsLabel': 'Your agents',
  'landing.team.humansLabel': 'Your people',
  'landing.team.humansNote':
    'A two-person studio in Europe, on CET hours. The agents do the work; we sign it off and answer the email.',
  'landing.differentiation.sub':
    'Specialized agents research, select, build, check and maintain. Our team owns the judgment, polish and final approval.',

  // Pricing — editorial redesign
  'landing.pricing.eyebrow': 'Pricing',
  'landing.pricing.headlinePrefix': 'Pay for progress.',
  'landing.pricing.headlineFlourish': 'Stay for the care.',

  // Testimonials — editorial redesign
  'landing.testimonials.eyebrow': 'In their words',
  'landing.testimonials.headlinePrefix': 'A real business',
  'landing.testimonials.headlineFlourish': 'we built this for',
  'landing.testimonials.cta': 'view site',

  // Manifesto — editorial redesign

  // Team — editorial redesign

  // FAQ — editorial redesign
  'landing.faq.eyebrow': 'Questions',
  'landing.faq.headlinePrefix': 'Before you book,',
  'landing.faq.headlineFlourish': 'the usual questions',

  // Proof — the shelf
  'landing.proof.eyebrow': 'Selected work',
  'landing.proof.headlinePrefix': 'Real sites,',
  'landing.proof.headlineFlourish': 'real businesses',
  'landing.proof.sub':
    'Sites already shipped, with more on the way. Open any card to see the full build.',
  'landing.proof.cta': 'See the work',
  'landing.proof.statusLive': 'live',
  'landing.proof.statusSoon': 'in development',

  // Audience — editorial redesign
  'landing.audience.eyebrow': "Who it's for",
  'landing.audience.headlinePrefix': 'Built for small businesses',
  'landing.audience.headlineFlourish': 'across Europe',
  'landing.audience.sub':
    'Whether you sell your time, sell products, or need something an off-the-shelf website cannot do, we should talk.',

  // Process — editorial redesign
  'landing.process.eyebrow': 'How it works',
  'landing.process.headlinePrefix': 'Preview first.',
  'landing.process.headlineFlourish': 'Commitment second.',
  'landing.process.sub':
    'You see the direction before the deposit, and the finished site before the final payment.',

  // Solution — editorial redesign
  'landing.solution.eyebrow': 'How we work',
  'landing.solution.headlinePrefix': 'We build it.',
  'landing.solution.headlineFlourish': 'You keep editing it.',
  'landing.solution.paragraph1':
    'Our agent chooses the strongest starting design for your business, then applies your voice, colors, content and goals. You get a proven starting point shaped around you, not a generic one-click result.',
  'landing.solution.paragraph2':
    'Then you get the smart editor for small wording changes. New sections, visual work and connected services go to the team already caring for your site.',

  // Support bot (floating widget on landing)
  'supportBot.openLabel': 'Open support chat',
  'supportBot.closeLabel': 'Close support chat',
  'supportBot.title': 'Ask anything',
  'supportBot.subtitle': "Quick answers, or we'll book a call",
  'supportBot.greeting': 'Hi! Ask about pricing, timelines, or how we work',
  'supportBot.placeholder': 'Type your question...',
  'supportBot.send': 'Send',
  'supportBot.contactOperator': 'Contact an operator',
  'supportBot.replyPrice':
    'Starter is €799 setup + €49/month. Pro starts at €1,199 + €79/month. Both include hosting, domain, and the smart editor. Want a personal walkthrough?',
  'supportBot.replyTimeline':
    'We agree on the timeline together during the discovery call. You see drafts before launch, and we keep you in the loop the whole way',
  'supportBot.replyEditor':
    'You get a smart editor for small wording changes. Bigger design changes or new service connections go to the Flowstarter care team',
  'supportBot.replyOwnership':
    'Yes, you own everything. Site, content, hosting are all in your name from day one. No platform lock-in',
  'supportBot.replyCapacity':
    "We take a limited number of new clients each month so every project gets real attention. If yours is a fit, we'll find a slot together on the call",
  'supportBot.replyDefault':
    'Good question. The fastest way to get a real answer is a 30-minute discovery call. Book one and we will cover it properly',
  'supportBot.replyDomain':
    'Yes, we set up your custom domain and a professional email address at that domain. If you already own one, we connect it. If not, we register it for you',
  'supportBot.replyDiscovery':
    "The discovery call runs up to 30 minutes. We'll cover your business, brand, and goals, and confirm honestly whether we're the right fit",
  'supportBot.replyEcommerce':
    'Complete online stores are available on the Ecommerce tier, including stock, shipping, tax and secure checkout. Pro is a better fit for a few digital products or paid sessions. Book a call and we will plan what you need',
  'supportBot.replyIncluded':
    'The build is a one-time cost: Starter from €799 and Pro from €1,199. The separate care plan starts at €49/month and covers your editor, hosting and support. Higher plans give you more ways to update the site yourself',
  'supportBot.replySupport':
    "We're with you after launch. The smart editor handles most updates. For bigger changes, your monthly subscription includes priority support",
  'supportBot.replyHandoff':
    "This one needs a human. Reach out to an operator and they'll handle it directly",
  'supportBot.replyError':
    "Something went wrong reaching me. Contact an operator below and we'll get you sorted",
  'supportBot.typing': 'Typing...',

  // Error pages (404, 500)
  'errors.404.headline': 'This page moved on',
  'errors.404.body':
    "Whatever you were looking for isn't here anymore, but we've got you covered",
  'errors.404.quickNav': 'Quick navigation',
  'errors.404.linkHome': 'Home',
  'errors.404.linkPricing': 'Pricing',
  'errors.404.linkFaq': 'FAQ',
  'errors.404.linkContact': 'Contact',
  'errors.404.goHome': 'Go Home',
  'errors.404.goBack': 'Go Back',
  'errors.500.headline': 'Something went wrong',
  'errors.500.body':
    "We've been notified. Try reloading the page, or head back home",
  'errors.500.errorIdLabel': 'Error ID',
  'errors.500.reload': 'Reload',
  'errors.500.goHome': 'Go Home',

  // PreQual modal
  'landing.prequal.calendar.back': 'Back',
  'landing.prequal.calendar.planSelected': 'plan selected',
  'landing.prequal.calendar.title': 'Pick a time that works for you',
  'landing.prequal.calendar.subtitle':
    "Choose a 30-minute slot below. We'll confirm via email",
  'landing.prequal.confirmed.title': "You're all set!",
  'landing.prequal.confirmed.body':
    'Your discovery call is booked. Check your email for the confirmation and calendar invite',
  'landing.prequal.confirmed.note':
    "We're looking forward to learning about your project",
  'landing.prequal.confirmed.cta': 'Done',
  'landing.prequal.close': 'Close',

  // Discovery wizard (multi-step pre-call form)
  'landing.discovery.eyebrow': 'Free discovery: a few minutes',
  'landing.discovery.nav.back': 'Back',
  'landing.discovery.nav.continue': 'Continue',
  'landing.discovery.nav.bookCall': 'book my call',
  'landing.discovery.nav.saveAndBook':
    'Prefer to talk first? Save & book a call',
  'landing.discovery.nav.submitting': 'Saving…',
  'landing.discovery.nav.payPrefix': 'Pay',
  'landing.discovery.nav.redirecting': 'Redirecting to secure checkout…',

  // Step titles + subtitles
  'landing.discovery.steps.about.title':
    "Let's get to know you and your business",
  'landing.discovery.steps.about.subtitle':
    "We'll send the call link and follow-ups to this email",
  'landing.discovery.steps.business.title': 'What does your business do?',
  'landing.discovery.steps.business.subtitle':
    'A couple of sentences is enough. What you do, and who for.',
  'landing.discovery.steps.goals.title': "What's the goal of the site?",
  'landing.discovery.steps.goals.subtitle':
    'Helps us recommend the right tier and shape the call',
  'landing.discovery.steps.commerce.title': 'Will you sell anything online?',
  'landing.discovery.steps.commerce.subtitle':
    'We pick the simplest provider that handles your needs',
  'landing.discovery.steps.recommendation.title': 'Your recommended plan',
  'landing.discovery.steps.recommendation.subtitle':
    "Based on your answers. You can adjust before booking, and we'll confirm scope on the call",
  'landing.discovery.steps.subscription.title': 'Pick your care plan',
  'landing.discovery.steps.subscription.subtitle':
    'Separate from the one-time build. It controls editor capabilities, and you can change it anytime',
  'landing.discovery.steps.subscription.subtitleStore':
    'Your store runs on a dedicated plan built for selling, not the standard editor tiers',
  'landing.discovery.subscription.tiers.starter': 'Starter',
  'landing.discovery.subscription.tiers.pro': 'Pro',
  'landing.discovery.subscription.tiers.max': 'Max',
  'landing.discovery.subscription.popular': 'Popular',
  'landing.discovery.subscription.cadence.monthly': 'Monthly',
  'landing.discovery.subscription.cadence.yearly': 'Yearly',
  'landing.discovery.subscription.footnote':
    'First month is free. No lock-in, so move up or down a plan whenever you want.',
  'landing.discovery.subscription.storeEyebrow': 'Dedicated store plan',
  'landing.discovery.subscription.storeName': 'Commerce',
  'landing.discovery.subscription.storeOps':
    'storefront support, order + catalog help',
  'landing.discovery.subscription.storeNote':
    'A dedicated store plan with product and collection editing, plus provider sync and order flows handled. Built for running a storefront, not just a content site.',
  'landing.discovery.steps.info.title': 'A couple of things before we build',
  'landing.discovery.steps.preview.title': 'Your site, being built',
  'landing.discovery.steps.preview.subtitle':
    'Generated from your answers, in seconds. The real one is designed properly on the call',
  'landing.discovery.preview.fallbackName': 'Your business',
  'landing.discovery.preview.fallbackTagline':
    'Work worth showing off, online at last',
  'landing.discovery.preview.audiencePrefix': 'For',
  'landing.discovery.preview.generating':
    'Building a first draft of your site from your answers…',
  'landing.discovery.preview.build.s1': 'Reading your answers',
  'landing.discovery.preview.build.s2': 'Choosing a layout for your business',
  'landing.discovery.preview.build.s3': 'Writing your sections',
  'landing.discovery.preview.build.s4': 'Putting the page together',
  'landing.discovery.preview.editorTitle':
    'Try the editor: ask for changes in plain English',
  'landing.discovery.preview.editsLeft': 'edits left',
  'landing.discovery.preview.editorPlaceholder':
    'e.g. "make the headline punchier" or "use a teal accent"',
  'landing.discovery.preview.apply': 'Apply',
  'landing.discovery.preview.applying': 'Applying…',
  'landing.discovery.preview.editFailed':
    "Couldn't apply that one. Try rewording it.",
  'landing.discovery.preview.limitReached':
    "You've used all your demo edits. The real editor has no limit.",
  'landing.discovery.preview.editorUnavailable':
    'Live editing is off in this environment: this is a static preview.',
  'landing.discovery.preview.deferredNow': 'Your preview is on its way',
  'landing.discovery.preview.deferredMessage':
    "We couldn't start your live preview just now. Nothing is lost: we will build it by hand and email it to you shortly.",
  'landing.discovery.preview.disclaimer':
    'A working preview built from your answers. The complete site is built by your agent team once the 20% deposit is paid, checked by us before it goes live, and ships with an editor that has no edit limit.',

  // The concierge stage: two panes, one conversation.
  'landing.discovery.preview.paneTitle': 'Your site, taking shape',
  'landing.discovery.preview.paneSkeleton':
    'Your site appears here as the agents build it. Nothing on this panel is real yet.',
  'landing.discovery.preview.askForChange': 'Ask for a change',

  // The intake conversation (steps 1–6). The question order, the validation
  // and the decision that the intake is finished all live in
  // `intake-script.ts` — this is only the phrasing. {name} and {business} are
  // filled from the visitor's own earlier answers.
  'landing.discovery.chat.title': "Let's talk about your site",
  'landing.discovery.chat.intro':
    "Hi, I'm your Flowstarter agent. A few short questions, and at the end of them you get a working preview of your site. Skip anything you'd rather not answer.",
  'landing.discovery.chat.agentName': 'Flowstarter agent',
  'landing.discovery.chat.logLabel': 'Your conversation',
  'landing.discovery.chat.progressLabel': 'Questions answered',
  'landing.discovery.chat.progressCount':
    '{done} of {total} questions answered',

  // The stepper above the conversation: all 8 stages, visible from the
  // first frame. Short labels — the long ones above are for the step
  // headings, these need to fit a small circle's width.
  'landing.discovery.stepper.label': 'Discovery progress',
  'landing.discovery.stepper.about': 'About you',
  'landing.discovery.stepper.business': 'Your business',
  'landing.discovery.stepper.goals': 'Goals & style',
  'landing.discovery.stepper.commerce': 'Selling online',
  'landing.discovery.stepper.recommendation': 'Your plan',
  'landing.discovery.stepper.subscription': 'Care plan',
  'landing.discovery.stepper.info': 'Details',
  'landing.discovery.stepper.preview': 'Preview',
  'landing.discovery.stepper.position': 'Step {n} of {total}: {label}',
  'landing.discovery.chat.composerLabel': 'Your answer',
  'landing.discovery.chat.composerPlaceholder': 'Type your answer…',
  'landing.discovery.chat.send': 'Send',
  'landing.discovery.chat.done': "That's it",
  'landing.discovery.chat.confirm': 'Looks good, carry on',
  'landing.discovery.chat.edit': 'Edit',
  'landing.discovery.chat.reask': "Sure, let's redo that one.",
  'landing.discovery.chat.skip': 'Skip this one',
  'landing.discovery.chat.skipped': 'Skipped for now',
  'landing.discovery.chat.tokens.you': 'there',
  'landing.discovery.chat.tokens.business': 'your business',

  'landing.discovery.chat.errors.required':
    "I do need this one, sorry. It's one of the few I can't build anything without.",
  'landing.discovery.chat.errors.fullName':
    'A first name is plenty. I just need something to call you.',
  'landing.discovery.chat.errors.email':
    "That doesn't look like an email address. Mind checking it?",
  'landing.discovery.chat.errors.description':
    'A little more than that, if you can: a sentence or two is all I need.',
  'landing.discovery.chat.errors.goal':
    'Pick at least one, or tell me in your own words.',
  'landing.discovery.chat.errors.choice':
    "I didn't catch that one. Tapping one of the options above is easiest.",

  'landing.discovery.chat.q.fullName.prompt':
    'First things first: what should I call you?',
  'landing.discovery.chat.q.email.prompt':
    "Where should I send your preview once it's ready?",
  'landing.discovery.chat.q.businessName.prompt':
    "And what's the business called? If you haven't settled on a name, skip it. We can come back to it.",
  'landing.discovery.chat.q.description.prompt':
    'Now the one that matters most: what does {business} actually do? Your own words, a sentence or two.',
  'landing.discovery.chat.q.industry.prompt':
    "Which of these is closest to your line of work? Tap one, or type it if it's none of them.",
  'landing.discovery.chat.q.targetAudience.prompt':
    "Who are you trying to reach? Describe them the way you'd describe them to a friend.",
  'landing.discovery.chat.q.links.prompt':
    'Anything of yours I can look at: Instagram, LinkedIn? Paste a link and I will match your voice to it.',
  'landing.discovery.chat.q.links.placeholder':
    'instagram.com/yourbusiness, linkedin.com/company/…',
  'landing.discovery.chat.q.goal.prompt':
    'What should the site actually do for you? Pick as many as fit, or add your own.',
  'landing.discovery.chat.q.goal.placeholder':
    'Something else you want it to do…',
  'landing.discovery.chat.q.brandTone.prompt':
    'How should {business} come across? Pick a few words.',
  'landing.discovery.chat.q.brandTone.placeholder': 'Add a word of your own…',
  'landing.discovery.chat.q.pageCount.prompt':
    'Roughly how big a site are we talking?',
  'landing.discovery.chat.q.timeline.prompt': 'When would you like it live?',
  'landing.discovery.chat.q.commerceMode.prompt':
    'Will you be selling anything through the site?',
  'landing.discovery.chat.q.catalogSize.prompt':
    'Roughly how many products or services?',
  'landing.discovery.chat.q.calComUrl.prompt':
    'If you already book clients on Cal.com, paste your booking link. Leave blank if you do not use Cal.com yet, and you can add it later from your project.',
  'landing.discovery.chat.q.customIntegrations.prompt':
    'Anything else it has to plug into? Payments, a mailing list, a member area. Bookings are covered above.',
  'landing.discovery.chat.q.selectedTier.prompt':
    "That's everything I need. Here's the build package your answers point to. Change it if you would rather.",
  'landing.discovery.chat.q.subscription.prompt':
    "One last decision: the monthly plan. It's separate from the build, and it's what decides how much you can change yourself afterwards.",

  // What the agent says back, before it asks the next thing. The line is
  // picked by rule from the stored answer (`reflectionText`); {answer} is
  // what they said, {quote} their first sentence, {list} a multi answer as
  // "a, b and c".
  'landing.discovery.chat.thinking': 'Thinking',
  'landing.discovery.chat.typeInstead': 'Or type your answer…',
  'landing.discovery.chat.tokens.and': 'and',
  'landing.discovery.chat.reflect.skipped.0':
    'No problem, we can come back to that.',
  'landing.discovery.chat.reflect.skipped.1': 'Fine by me. Moving on.',
  'landing.discovery.chat.reflect.skipped.2':
    'Skipped. Nothing here is locked in.',
  'landing.discovery.chat.q.fullName.reflect': 'Hey {name}, good to meet you.',
  'landing.discovery.chat.q.email.reflect':
    "Got it. The preview goes to {answer} once it's built, and nowhere else.",
  'landing.discovery.chat.q.businessName.reflect':
    "{answer}. That's the name I'll use everywhere the site says who you are.",
  'landing.discovery.chat.q.businessName.reflect.skipped':
    'No name yet is fine. I\'ll say "your business" for now and we can name it later.',
  'landing.discovery.chat.q.description.reflect':
    '"{quote}." That\'s the line I\'ll write the whole site around.',
  'landing.discovery.chat.q.industry.reflect':
    '{answer}, got it. That tells me which layouts and photography to start from.',
  'landing.discovery.chat.q.industry.reflect.skipped':
    "No box needed. I'll go by what you told me instead.",
  'landing.discovery.chat.q.targetAudience.reflect':
    'So the site talks to {quote}. Every headline gets written for them, not for everyone.',
  'landing.discovery.chat.q.targetAudience.reflect.skipped':
    "Fine, I'll write for the people your description points at.",
  'landing.discovery.chat.q.links.reflect':
    "Thanks. I'll read through that before I write a word, so the site sounds like you.",
  'landing.discovery.chat.q.links.reflect.skipped':
    "No problem. I'll work from your own words instead.",
  'landing.discovery.chat.q.goal.reflect':
    'So its job is to {list}. That decides what goes above the fold.',
  'landing.discovery.chat.q.brandTone.reflect':
    "{answer}: that's the voice, then. I'll keep every line to it.",
  'landing.discovery.chat.q.brandTone.reflect.skipped':
    "I'll pick a tone from how you described the business. You can change it later.",
  'landing.discovery.chat.q.pageCount.reflect.lt-5':
    'A small, focused site. Those usually convert best.',
  'landing.discovery.chat.q.pageCount.reflect.5-7':
    'Five to seven pages, the classic setup.',
  'landing.discovery.chat.q.pageCount.reflect.8-15':
    "A proper multi-page site. I'll plan the navigation carefully.",
  'landing.discovery.chat.q.pageCount.reflect.15+':
    "A big one. I'll structure it so things stay easy to find.",
  'landing.discovery.chat.q.pageCount.reflect.unsure':
    "No need to decide now. I'll propose a page list in the preview.",
  'landing.discovery.chat.q.pageCount.reflect.skipped':
    "I'll propose a page list in the preview and you can trim it.",
  'landing.discovery.chat.q.timeline.reflect.asap':
    'Fast it is. The preview is minutes away, and the build follows the deposit.',
  'landing.discovery.chat.q.timeline.reflect.4-weeks':
    'Four weeks is comfortable. Plenty of room for revisions.',
  'landing.discovery.chat.q.timeline.reflect.1-3-months':
    'No rush, then. We can take the time to get the content right.',
  'landing.discovery.chat.q.timeline.reflect.flexible':
    "Flexible works. We'll move at your pace.",
  'landing.discovery.chat.q.commerceMode.reflect.none':
    'No store, then. That keeps the build simpler and cheaper.',
  'landing.discovery.chat.q.commerceMode.reflect.few-services':
    'A few paid offers. Each one gets its own section with a clear call to action.',
  'landing.discovery.chat.q.commerceMode.reflect.digital':
    "Digital products. I'll plan a store with instant delivery after checkout.",
  'landing.discovery.chat.q.commerceMode.reflect.physical':
    "Physical products. I'll plan a store with shipping and stock in mind.",
  'landing.discovery.chat.q.commerceMode.reflect.mixed':
    "A bit of both. I'll set up a store that handles digital and shipped orders.",
  'landing.discovery.chat.q.catalogSize.reflect.1-5':
    'A small catalogue. Each item gets room to shine.',
  'landing.discovery.chat.q.catalogSize.reflect.6-25':
    "A mid-size catalogue. I'll add categories so it stays browsable.",
  'landing.discovery.chat.q.catalogSize.reflect.26-100':
    'A sizeable catalogue. Filters and search go in from the start.',
  'landing.discovery.chat.q.catalogSize.reflect.100+':
    "A large catalogue. I'll plan for search, filters and bulk import.",
  'landing.discovery.chat.q.catalogSize.reflect.unsure':
    'We can size the catalogue later. The store scales either way.',
  'landing.discovery.chat.q.calComUrl.reflect':
    "Booking link saved. The site's booking buttons will open it.",
  'landing.discovery.chat.q.calComUrl.reflect.skipped':
    'No booking link for now. You can add one from your project later.',
  'landing.discovery.chat.q.customIntegrations.reflect':
    "Noted. I'll flag that for the build so it's planned in, not bolted on.",
  'landing.discovery.chat.q.customIntegrations.reflect.skipped':
    'Nothing extra to plug in. Simple is good.',
  'landing.discovery.chat.q.selectedTier.reflect.starter':
    'Starter it is. Lean and quick to launch.',
  'landing.discovery.chat.q.selectedTier.reflect.pro':
    'Pro. Good choice for a site that needs room to grow.',
  'landing.discovery.chat.q.selectedTier.reflect.commerce':
    'Commerce. The store plan comes with it.',
  'landing.discovery.chat.q.selectedTier.reflect.custom':
    'Custom. Someone from our team will scope that with you before anything is built.',

  // Field labels
  'landing.discovery.fields.fullName': 'Your name',
  'landing.discovery.fields.email': 'Email',
  'landing.discovery.fields.businessName': 'Business name',
  'landing.discovery.fields.description': 'In one or two sentences',
  'landing.discovery.fields.industry': 'Industry',
  'landing.discovery.industryOther': 'Other',
  'landing.discovery.fields.targetAudience': 'Target audience',
  'landing.discovery.fields.instagramUrl': 'Instagram profile',
  'landing.discovery.fields.linkedinUrl': 'LinkedIn profile',
  'landing.discovery.fields.goal': 'Goals',
  'landing.discovery.fields.secondaryGoals': 'Secondary goals (optional)',
  'landing.discovery.hints.secondaryGoals':
    'Anything else the site should do, beyond the main goal',
  'landing.discovery.fields.brandTone': 'Brand tone',
  'landing.discovery.fields.pageCount': 'Approximate page count',
  'landing.discovery.fields.timeline': 'Timeline',
  'landing.discovery.fields.commerceMode': 'What will the site sell?',
  'landing.discovery.fields.catalogSize': 'How many products / services?',
  'landing.discovery.fields.calComUrl': 'Cal.com booking link',
  'landing.discovery.fields.customIntegrations':
    'Anything custom we should know about?',

  // Hints
  'landing.discovery.hints.businessName':
    'Optional: leave blank if you have not picked a name yet',
  'landing.discovery.hints.description':
    'Plain language. What you do and who for',
  'landing.discovery.hints.socialProfiles':
    'Optional. We use public business content to learn your voice and visual direction.',
  'landing.discovery.hints.pageCount':
    'Rough estimate: we will refine on the call',
  'landing.discovery.hints.customIntegrations':
    'Payments, mailing lists, member areas, but not Cal.com (that has its own field)',
  'landing.discovery.hints.calComUrl':
    'Example: https://cal.com/your-name/intro',

  // Placeholders
  'landing.discovery.placeholders.fullName': 'Maria Ionescu',
  'landing.discovery.placeholders.email': 'maria@example.com',
  'landing.discovery.placeholders.businessName': 'Smile Dental Clinic',
  'landing.discovery.placeholders.description':
    'e.g. Boutique dental clinic in Cluj offering cosmetic and pediatric services',
  'landing.discovery.placeholders.industry': 'Choose your industry…',
  'landing.discovery.placeholders.industryOther': 'Tell us your industry',
  'landing.discovery.placeholders.targetAudience':
    'Who your ideal customers are, in plain words',
  'landing.discovery.placeholders.calComUrl': 'https://cal.com/your-name/intro',
  'landing.discovery.placeholders.customIntegrations':
    'e.g. Stripe payment links, Mailchimp for newsletters, FANBox pickup points',

  // Goal options
  'landing.discovery.options.goal.leads.label': 'Get leads',
  'landing.discovery.options.goal.leads.sub':
    'Receive contact requests and win more enquiries',
  'landing.discovery.options.goal.sales.label': 'Sell products',
  'landing.discovery.options.goal.sales.sub':
    'Drive purchases of physical or digital goods',
  'landing.discovery.options.goal.bookings.label': 'Take bookings',
  'landing.discovery.options.goal.bookings.sub':
    'Sessions, appointments, classes, consultations',
  'landing.discovery.options.goal.portfolio.label': 'Showcase work',
  'landing.discovery.options.goal.portfolio.sub':
    'Portfolio, case studies, brand presence',

  // Tone options
  'landing.discovery.options.tone.professional': 'Professional',
  'landing.discovery.options.tone.bold': 'Bold',
  'landing.discovery.options.tone.friendly': 'Friendly',
  'landing.discovery.options.tone.minimal': 'Minimal',

  // Page count options
  'landing.discovery.options.pages.lt-5.label': 'Under 5',
  'landing.discovery.options.pages.lt-5.sub': 'Single landing or simple site',
  'landing.discovery.options.pages.5-7.label': '5 – 7',
  'landing.discovery.options.pages.5-7.sub': 'Standard service site',
  'landing.discovery.options.pages.8-15.label': '8 – 15',
  'landing.discovery.options.pages.8-15.sub': 'Multi-page or content-driven',
  'landing.discovery.options.pages.15+.label': '15+',
  'landing.discovery.options.pages.15+.sub': 'Large site, blog, locations',
  'landing.discovery.options.pages.unsure.label': 'Not sure',
  'landing.discovery.options.pages.unsure.sub': "We'll work it out on the call",

  // Timeline options
  'landing.discovery.options.timeline.asap': 'ASAP',
  'landing.discovery.options.timeline.4-weeks': 'Within 4 weeks',
  'landing.discovery.options.timeline.1-3-months': '1 – 3 months',
  'landing.discovery.options.timeline.flexible': 'Flexible',

  // Commerce options
  'landing.discovery.options.commerce.none.label': 'No products',
  'landing.discovery.options.commerce.none.sub':
    'Brand presence + lead capture only',
  'landing.discovery.options.commerce.few-services.label': 'A few paid offers',
  'landing.discovery.options.commerce.few-services.sub':
    'Let customers pay for services or single sessions online',
  'landing.discovery.options.commerce.digital.label': 'Digital products',
  'landing.discovery.options.commerce.digital.sub':
    'Courses, downloads, templates, software',
  'landing.discovery.options.commerce.physical.label': 'Physical products',
  'landing.discovery.options.commerce.physical.sub':
    'Shipped goods with stock, sizes or options, and delivery',
  'landing.discovery.options.commerce.mixed.label': 'Mix of both',
  'landing.discovery.options.commerce.mixed.sub':
    'Physical catalog plus digital add-ons',

  // Catalog size options
  'landing.discovery.options.catalog.1-5': '1 – 5',
  'landing.discovery.options.catalog.6-25': '6 – 25',
  'landing.discovery.options.catalog.26-100': '26 – 100',
  'landing.discovery.options.catalog.100+': '100+',
  'landing.discovery.options.catalog.unsure': 'Not sure',

  // Tier names + taglines (used in recommendation card and override picker)
  'landing.discovery.tiers.starter.name': 'Starter',
  'landing.discovery.tiers.starter.tagline':
    'Polished service site, no online store',
  'landing.discovery.tiers.pro.name': 'Pro',
  'landing.discovery.tiers.pro.tagline':
    'Multi-page site with simple paid offers',
  'landing.discovery.tiers.commerce.name': 'Commerce',
  'landing.discovery.tiers.commerce.tagline':
    'A complete online store with your products',
  'landing.discovery.tiers.custom.name': 'Custom',
  'landing.discovery.tiers.custom.tagline':
    'A made-to-measure build for unusual requirements',

  // Recommendation card
  'landing.discovery.recommendation.eyebrow': 'Best fit for you',
  'landing.discovery.recommendation.setupFrom': 'Setup from',
  'landing.discovery.recommendation.from': 'from',
  'landing.discovery.recommendation.bestMatchBadge': 'Match',
  'landing.discovery.recommendation.overrideLabel':
    'Want a different tier? Pick one, and we will discuss on the call',
  'landing.discovery.recommendation.footnote':
    'All prices are starting points. Final scope is agreed on the discovery call.',

  // Build deposit policy — charged only after generated preview approval.
  'landing.discovery.recommendation.deposit.title':
    'No payment during discovery',
  'landing.discovery.recommendation.deposit.percentSuffix': '% of setup',
  'landing.discovery.recommendation.deposit.body':
    'We first create your tailored preview and confirm the final quote. When you approve it, a 20% deposit locks the design and starts the full build. The remaining 80% is due after final review.',

  // Recommendation reasons (rule engine output)
  'landing.discovery.recommendation.reasons.customIntegrations':
    'You mentioned specialist services or unusual requirements, so we should plan them with you',
  'landing.discovery.recommendation.reasons.physicalCatalog':
    'A larger product range needs stock and shipping built in',
  'landing.discovery.recommendation.reasons.digitalCatalog':
    'A digital product range needs secure delivery, tax handling and a customer area',
  'landing.discovery.recommendation.reasons.simplePayments':
    'Pro is a good fit when customers need to pay for a few offers online',
  'landing.discovery.recommendation.reasons.multiPage':
    'A larger site needs more design work and a clearer way for visitors to get around',
  'landing.discovery.recommendation.reasons.contentDriven':
    'Pro gives a lead-focused site more room for useful content and articles',
  'landing.discovery.recommendation.reasons.servicePresentation':
    'A clean, fast presentation site is exactly what Starter is built for',
  'landing.discovery.recommendation.reasons.bookingFriendly':
    'Starter works well when customers simply need to book appointments',
  'landing.discovery.recommendation.reasons.portfolioFriendly':
    'A portfolio does not need the cost or complexity of an online store',
  'landing.discovery.recommendation.reasons.fastTurnaround':
    'Tight timeline: we will scope something we can ship in weeks, not months',
  'landing.discovery.recommendation.reasons.default':
    'Best match based on your answers',

  // Ecommerce waitlist modal

  // Final CTA — editorial redesign
  'landing.finalCta.eyebrow': 'Ready when you are',
  'landing.finalCta.headlinePrefix': 'Your first direction',
  'landing.finalCta.headlineFlourish': 'starts with what you share',
  'landing.finalCta.subhead':
    'Share your business details and the public profiles you choose. We will turn them into a tailored first direction for you to review.',
  'landing.finalCta.primaryCta': 'Build my site',
  'landing.finalCta.microNote':
    'No payment until your tailored preview is ready',

  // About page
  'about.eyebrow': 'About Flowstarter',
  'about.headlinePrefix': 'Two founders.',
  'about.headlineFlourish': 'One job: get you online.',
  'about.sub':
    "We're a small studio that builds websites, online stores, and custom software for service professionals across Europe. Dorin designs them, Darius engineers them, and both of us support them. Two founders, direct, no hand-off to a junior you never met.",
  'about.darius.name': 'Darius',
  'about.darius.role': 'Build & reliability',
  'about.darius.bio1':
    'Ten years building dependable websites and online services, including email, payments and backups. The things that quietly fail at 3am if nobody owns them.',
  'about.darius.bio2':
    'I care about sites that work. I am not in love with frameworks, I am in love with things that do not break. My job here is to make the engineering invisible so you can forget the platform exists and get back to your clients.',
  'about.darius.meta': 'Europe-based \u00b7 CET hours',
  'about.dorin.name': 'Dorin',
  'about.dorin.role': 'Design & craft',
  'about.dorin.bio1':
    'A decade designing for small studios and independent professionals who needed to look as serious as they already were. Careful details, restraint, and knowing the difference between clean and bland.',
  'about.dorin.bio2':
    'I will not ship a first impression I do not believe in. I start with your voice and the feeling your business should create, then carry that through every page. Your site should look like people made it on purpose, for you.',
  'about.dorin.meta': 'Europe-based \u00b7 CET hours',
  'about.manifesto.eyebrow': 'Why we built this',
  'about.manifesto.headlinePrefix': 'Real expertise',
  'about.manifesto.headlineFlourish': 'should be easier to find.',
  'about.manifesto.p1':
    'Too many good service professionals are invisible online. Not for lack of talent, but because the tools are built for developers, not for them. The traditional ways come with the same problems: generic output, long timelines, and a system you never own.',
  'about.manifesto.p2':
    'Flowstarter is the thing we wanted to exist. A real team builds you a real site, quickly, and a smart editor lets you keep changing it without learning new software. We take on fewer projects so you get a site you fully own and can keep improving.',
  'about.manifesto.closing': 'Your work is good. Your website should say so.',
  'about.principles.eyebrow': 'How we work',
  'about.principles.headlinePrefix': 'Three principles',
  'about.principles.headlineFlourish': "we don't bend on.",
  'about.principle1.title': 'Speed.',
  'about.principle1.body':
    'We move quickly. Most briefs turn into a live site in weeks, not months, and we do not cut the craft to get there.',
  'about.principle2.title': 'Craft.',
  'about.principle2.body':
    'Built properly every time. No copy-and-paste designs, no generic AI writing, no "we will fix it later." It goes out the way it should have in the first place.',
  'about.principle3.title': 'Honesty.',
  'about.principle3.body':
    'Transparent pricing, direct conversation, no surprise invoices. You always know what you are getting and what it costs.',
  'about.steps.eyebrow': 'What to expect',
  'about.steps.headlinePrefix': 'From the first email',
  'about.steps.headlineFlourish': 'to your launch day.',
  'about.step1.title': 'You write to us.',
  'about.step1.body':
    'Or book the call directly. There is no sales team here. You talk to one of us, every time.',
  'about.step2.title': 'We design and build.',
  'about.step2.body':
    'Together. Dorin leads the design, brand and words. Darius builds the site, connects your services and gets it live. You see progress instead of silence.',
  'about.step3.title': 'You run it.',
  'about.step3.body':
    'With the smart editor and our support behind it. We are a message away when you need us, whether that is a change, some advice, or whatever comes next.',
  'about.cta.eyebrow': 'Want to talk?',
  'about.cta.headlinePrefix': 'No slides. No sales team.',
  'about.cta.headlineFlourish': 'Just us, and your plan.',
  'about.cta.sub':
    "A 30-minute call is the easiest way to see if we're the right team for what you need.",
  'about.cta.button': 'Get my custom plan',
  'about.cta.note':
    '30 minutes \u00b7 no commitment \u00b7 first month free on signup',

  // FAQ standalone page
  'faq.eyebrow': 'FAQ',
  'faq.headlinePrefix': "Everything you've",
  'faq.headlineFlourish': 'asked us so far.',
  'faq.sub':
    'The questions we hear most often, answered honestly and at length. If your question is not here, write to us \u2014 we will add it.',
  'faq.stillWondering': 'Still wondering?',
  'faq.stillWonderingBody':
    'The fastest answer is a 30-minute call. We come prepared, no slides, no sales script.',
  'faq.bookCall': 'Get my custom plan',
  'faq.sendMessage': 'Send a longer message \u2192',

  // Relaunch page
  'relaunch.eyebrow': 'Relaunch',
  'relaunch.headlinePrefix': 'Your site exists.',
  'relaunch.headlineFlourish': "It just isn't getting you customers.",
  'relaunch.sub':
    "We audit what's not working, migrate your content, and rebuild your site around converting visitors. You keep your Google rankings.",
  'relaunch.pain.eyebrow': 'Sound familiar?',
  'relaunch.pain.headlinePrefix': 'The four reasons',
  'relaunch.pain.headlineFlourish': 'most sites quietly leak revenue.',
  'relaunch.pain1.title': 'Visitors leave without contacting you',
  'relaunch.pain1.body':
    'Your site gets traffic but nobody books, buys, or reaches out. The structure is not built to convert.',
  'relaunch.pain2.title': 'It looks outdated or unfinished',
  'relaunch.pain2.body':
    'The site does not match the quality of your actual work. People decide in a few seconds, and right now that decision is going against you.',
  'relaunch.pain3.title': "You can't update it yourself",
  'relaunch.pain3.body':
    'Every small change means emailing a developer or fighting a clunky builder. So nothing gets updated.',
  'relaunch.pain4.title': "No idea what is or isn't working",
  'relaunch.pain4.body':
    'No analytics, no tracking. You have no way of knowing where visitors come from or why they leave.',
  'relaunch.included.eyebrow': "What's included",
  'relaunch.included.headlinePrefix': 'Rebuilt to actually convert,',
  'relaunch.included.headlineFlourish': 'starting at \u20ac799.',
  'relaunch.included.sub':
    'Final price depends on scope and complexity. We assess it together on the discovery call, so the number we send you is the number you pay.',
  'relaunch.included.item1':
    'A full audit of your current site and what is costing you leads.',
  'relaunch.included.item2':
    'Content migration. Your existing copy, images and pages come across.',
  'relaunch.included.item3':
    'SEO redirect mapping so you keep your Google rankings.',
  'relaunch.included.item4':
    'A new structure built to turn visitors into customers.',
  'relaunch.included.item5':
    'Booking, contact form and analytics, all connected.',
  'relaunch.included.item6':
    'The smart editor, so you can change anything yourself after launch without code.',
  'relaunch.included.item7': 'Your own business dashboard.',
  'relaunch.included.item8':
    'First month free. 50% setup refund if not happy in 30 days.',
  'relaunch.form.titlePending': 'Tell us about your site.',
  'relaunch.form.titleDone': "Good. Let's talk.",
  'relaunch.form.subPending':
    "Share your URL and we'll come prepared to your discovery call.",
  'relaunch.form.subDone':
    "Get your custom plan, then book a free discovery call and we'll review your site together.",
  'relaunch.form.urlLabel': 'Your current website URL',
  'relaunch.form.problemsLabel': "What's not working? (optional)",
  'relaunch.form.problemsPlaceholder':
    "e.g. nobody contacts me, the design looks dated, I can't change anything myself",
  'relaunch.form.submit': 'Book my free audit call',
  'relaunch.form.note':
    'Free \u00b7 no commitment \u00b7 30 minutes \u00b7 we come prepared',
  'relaunch.form.reviewPrefix': 'We will review',
  'relaunch.form.reviewSuffix': 'before the call.',
  'relaunch.form.pickTime': 'Pick a time for your call',
  'relaunch.guarantee':
    '20% upfront to start. The remaining 80% is due only when you approve the result. First month free. Not happy within 30 days? We refund 50% of the setup fee. No questions asked.',

  // Cookies page hero
  'cookies.heroEyebrow': 'Cookies',
  'cookies.heroHeadlinePrefix': 'A small handful',
  'cookies.heroHeadlineFlourish': 'of well-behaved cookies.',
  'cookies.heroSub':
    'We only use cookies that keep the site working and remember your basic preferences. No advertising trackers, no third-party fingerprinting.',
  'cookies.lastUpdatedLabel': 'Last updated',

  ...adminKeys,
} as const;

export default en;
