-- ADR 0134 amendment 3 (9 Nov 2026): gate 1 covers every published stable version. The stable versions once excluded
-- as over_cap (older than a server's newest 150) go back to pending at tier 1, so the plan offers them only after every
-- tier-0 version. Prereleases stay excluded. Apply only after the code that orders by tier is deployed
-- (docs/runbooks/tool-history-cap.md): older code ignores tier and would mix these into rank order.
UPDATE `tool_history_queue` SET `status` = 'pending', `reason` = NULL, `tier` = 1, `attempts` = 0 WHERE `status` = 'excluded' AND `reason` = 'over_cap';
