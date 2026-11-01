import type { StatementLayout } from '../statement';
import { chaseCard } from './chaseCard';
import { fidelityReport } from './fidelityReport';
import { wellsFargoCard } from './wellsFargoCard';
import { wellsFargoDeposit } from './wellsFargoDeposit';

/** Every statement layout the import reads, tried in order. */
export const LAYOUTS: StatementLayout[] = [chaseCard, wellsFargoCard, wellsFargoDeposit, fidelityReport];
