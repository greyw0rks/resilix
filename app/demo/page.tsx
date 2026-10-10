import type { Metadata } from 'next';
import { DemoWalkthrough } from '@/components/DemoWalkthrough';

export const metadata: Metadata = {
  title: 'Resilix — guided walkthrough',
  description:
    'A narrated walkthrough of one protected action moving through policy, shared-control approval, distributed-hosting resilience and immutable audit.',
};

export default function DemoPage() {
  return <DemoWalkthrough />;
}
