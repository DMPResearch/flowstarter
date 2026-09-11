'use client';

import { Badge } from '@/components/ui/badge';
import { CheckCircle2, AlertCircle } from 'lucide-react';

export function IntegrationStatusBadge({ isActive }: { isActive: boolean }) {
  return isActive ? (
    <Badge variant="tone" tone="ok" className="text-xs">
      <CheckCircle2 className="w-3 h-3 mr-1" /> Connected
    </Badge>
  ) : (
    <Badge variant="tone" tone="warn" className="text-xs">
      <AlertCircle className="w-3 h-3 mr-1" /> Inactive
    </Badge>
  );
}
