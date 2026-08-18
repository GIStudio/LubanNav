import { useEffect, useState } from 'preact/hooks';
import { MODES, NODE_BY_ID } from '../data/campus.js';
import { findRoute } from './pathfinding.js';

function validPublicLocation(id) {
  return Boolean(NODE_BY_ID[id]?.public);
}

/**
 * Route query state: `from` / `to` / `mode` initialized from the URL search
 * params, kept in sync back into the URL, plus `applyNavigation(parsed)` —
 * the single place that turns a parsed navigation intent into the active
 * route (shared by the text chat, the voice transcript and the voice tool
 * callback).
 */
export function useRouteQueryState(params) {
  const [from, setFrom] = useState(() =>
    validPublicLocation(params.get('from')) ? params.get('from') : 'main-entrance');
  const [to, setTo] = useState(() =>
    validPublicLocation(params.get('to')) ? params.get('to') : 'library');
  const [mode, setMode] = useState(() =>
    MODES[params.get('mode')] ? params.get('mode') : 'pedestrian');

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('from', from);
    url.searchParams.set('to', to);
    url.searchParams.set('mode', mode);
    url.searchParams.delete('q');
    window.history.replaceState({}, '', url);
  }, [from, to, mode]);

  /**
   * Resolve and commit a parsed navigation intent. Returns the route response
   * (callers use `status === 'ok'` to decide how to phrase the reply); the
   * route state is only committed for routable pairs.
   */
  function applyNavigation(parsed) {
    const nextRoute = findRoute(parsed.from, parsed.to, parsed.mode);
    if (nextRoute.status === 'ok') {
      setFrom(parsed.from);
      setTo(parsed.to);
      setMode(parsed.mode);
    }
    return nextRoute;
  }

  return { from, to, mode, setFrom, setTo, setMode, applyNavigation };
}
