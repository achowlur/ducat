---
name: debug-hydration
description: Diagnose a React hydration error or a Ducat page that renders and then stops responding (no click handler works, the theme flips, "every page throws"). Read the dev-server terminal and the Next overlay instead of the truncated console, and hard-navigate before calling a bug global.
---

# Debug a hydration error

The browser console TRUNCATES React's hydration error: the tree diff that
names the mismatching node is cut off, and what remains blames whatever
attribute looks suspicious. In Ducat it usually blames the pre-paint
`data-theme`, which is the consequence and not the cause.

1. **The dev-server terminal first** (`preview_logs`). React's serializer
   prints the specific violation there, often with the literal fix.
2. **The Next.js dev overlay next,** read out of its shadow root with
   `javascript_tool`:

   ```js
   document.querySelector('nextjs-portal').shadowRoot
     .querySelector('[data-issues-open=true]').click()      // then:
   document.querySelector('nextjs-portal').shadowRoot
     .querySelector('[data-nextjs-dialog]').innerText       // diff + file:line
   ```

   `[data-next-badge]`'s `data-error` attribute is a clean per-page yes/no.
3. **Hard-navigate each route** before believing a bug is global. The overlay
   badge and the console both survive SOFT navigation, so one broken page
   looks like all of them. `/login` redirects to `/` when the gate is off.
4. **Suspect the known cause:** an SVG `<title>` with two JSX children
   serializes as `<title></title>` server-side. It takes ONE string child.
5. **"Dev only"?** Prove it by serving a production build on its own port
   (never `npm run build` while the dev server runs; see CLAUDE.md). The
   serializer is identical in both; only the warnings are dev-only.
6. **"Cannot find module './NNN.js'"** with no client handler working is not
   a hydration bug: a build corrupted the dev server's `.next/`. Stop dev,
   delete `.next/`, restart.
