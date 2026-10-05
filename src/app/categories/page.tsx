import Link from "next/link";
import { CategoryManager, type OwnCategory } from "../../components/CategoryManager";
import { CHIP, COLUMN_HEADER, PageTitle, SectionTitle } from "../../components/ui/headings";
import { withDatabaseNotice } from "../../components/DatabaseNotice";
import { isPackCategory } from "../../lib/categoryEdits";
import { prisma } from "../../lib/prisma";
import { transactionsHref } from "../../lib/ui/categoryFilter";

export const dynamic = "force-dynamic";

/**
 * Every category, with what points at it: the operator's own, which can be
 * renamed and deleted here, and the rule pack's, which keep their names
 * because the pack and the app find them by name (lib/categoryEdits.ts).
 *
 * Not a tab. A category is made in the ledger's picker by typing a name that
 * matches none, and the picker links here, so the place a mistake is noticed
 * is one tap from the place it is fixed.
 */
export default async function CategoriesPage() {
  return withDatabaseNotice(renderCategories);
}

async function renderCategories() {
  // Three statements, one round trip each; the counts are grouped in the
  // database rather than by loading every row.
  const [categories, rowCounts, ruleCounts] = await Promise.all([
    prisma.category.findMany({ select: { id: true, name: true, isIncome: true } }),
    prisma.transaction.groupBy({ by: ["categoryId"], _count: { _all: true } }),
    prisma.rule.groupBy({ by: ["setCategoryId"], _count: { _all: true } }),
  ]);
  const rowsOf = new Map(rowCounts.map((r) => [r.categoryId, r._count._all]));
  const rulesOf = new Map(ruleCounts.map((r) => [r.setCategoryId, r._count._all]));
  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, "en-US", { sensitivity: "base" });

  const counted = categories
    .map((c) => {
      const rows = rowsOf.get(c.id) ?? 0;
      return { ...c, rows, rules: rulesOf.get(c.id) ?? 0, href: rows === 0 ? null : transactionsHref([c.id]) };
    })
    .sort(byName);
  const own: OwnCategory[] = counted.filter((c) => !isPackCategory(c.name));
  const pack = counted.filter((c) => isPackCategory(c.name));

  return (
    <div className="grid gap-10 py-5">
      <div>
        <PageTitle>Categories</PageTitle>
        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-ink pb-3">
          <Link href="/transactions" className="tap44 text-[0.85rem] text-acc hover:underline">
            ‹ Transactions
          </Link>
        </div>
      </div>

      <section className="max-w-[720px]">
        <SectionTitle>Your categories</SectionTitle>
        <CategoryManager own={own} options={categories.map((c) => ({ ...c })).sort(byName)} />
      </section>

      <section className="max-w-[720px]">
        <SectionTitle>The rule pack&apos;s categories</SectionTitle>
        <p className="mb-3 text-[0.85rem] text-faint">
          These keep their names: the pack finds them by name each time it installs, and parts of the app
          read them by name, Rent &amp; Housing for house readiness among them. To move rows out of one,
          use the ledger&apos;s picker.
        </p>
        <table className="w-full border-collapse text-[0.85rem]">
          <thead>
            <tr className="border-b border-ink text-left">
              <th scope="col" className={`py-1.5 pr-3 ${COLUMN_HEADER}`}>
                Category
              </th>
              <th scope="col" className={`w-px py-1.5 pr-3 text-right ${COLUMN_HEADER}`}>
                Rows
              </th>
              <th scope="col" className={`w-px py-1.5 text-right ${COLUMN_HEADER}`}>
                Rules
              </th>
            </tr>
          </thead>
          <tbody>
            {pack.map((c) => (
              <tr key={c.id} className="border-b border-rule">
                <td className="py-1.5 pr-3">
                  <span className="flex items-baseline gap-1.5">
                    {c.name}
                    {/* Not on Income itself: there the chip only repeats the name. */}
                    {c.isIncome && c.name.toLowerCase() !== "income" && (
                      <span className={`${CHIP} bg-chip text-acc`}>Income</span>
                    )}
                  </span>
                </td>
                <td className="py-1.5 pr-3 text-right font-money tabular">
                  {c.href === null ? (
                    c.rows
                  ) : (
                    <Link href={c.href} className="tap44 underline decoration-rule underline-offset-2 hover:text-acc">
                      {c.rows.toLocaleString("en-US")}
                    </Link>
                  )}
                </td>
                <td className="py-1.5 text-right font-money tabular">{c.rules}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
