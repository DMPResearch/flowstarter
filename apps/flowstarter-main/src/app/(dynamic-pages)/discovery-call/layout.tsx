import type { ReactNode } from 'react';

export const metadata = {
  title: 'Book a discovery call',
  description:
    'Thirty minutes with Darius to scope custom work through DMPResearch. Nothing to prepare.',
};

export default function DiscoveryCallLayout({
  children,
}: {
  children: ReactNode;
}) {
  return <>{children}</>;
}
