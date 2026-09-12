/** @type {import('next-sitemap').IConfig} */
module.exports = {
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL || 'https://flowstarter.net',
  generateRobotsTxt: true,
  exclude: [
    '/dashboard/*',
    '/api/*',
    '/sign-up',
    '/login',
  ],
  robotsTxtOptions: {
    policies: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/dashboard', '/api', '/sign-up', '/login'],
      },
    ],
  },
};
