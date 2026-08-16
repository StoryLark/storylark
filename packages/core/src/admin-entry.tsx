/// <reference path="./virtual.d.ts" />
// The standalone admin page's entry point (AB#7404).
//
// This is a SECOND Vite entry, built alongside the reader app but sharing
// none of its runtime: no router, no player, no library/manifest loading, no
// IndexedDB, no service worker registration. The only things it pulls from
// core are the admin screen itself, the brand config, and the same stylesheet
// files the reader uses — CSS, not code — so the portal looks like the rest of
// the site without carrying any of it.
//
// It is also deliberately kept out of the PWA: no manifest link, and its
// files are excluded from the service worker precache (see
// storylark-core/vite). A reader who installs the app never carries admin
// code, and the operator never looks at a stale cached admin UI while pushing
// a platform update.
import { render } from 'preact';
import { BRAND } from './brand';
import { Admin } from './screens/Admin';
import 'virtual:storylark-theme.css';
import 'virtual:storylark-fonts';
import './styles/base.css';
import './styles/ui2.css';

const el = document.getElementById('admin');
if (el) {
  document.title = `Admin — ${BRAND.appName}`;
  render(<Admin />, el);
}
