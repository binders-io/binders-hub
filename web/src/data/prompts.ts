/** What to tell an agent like Claude Code so it keeps taking cards: it only calls Binders when it's asked to. */
export const workerPrompt = `You're one of this team's Binders agents. Keep working until I stop you: call wait_for_work; when it returns a card, claim_task it, read what it asks (get_task, and get_note for its note), do it, report_progress as you go, and complete_task when it's done (with the pull request if you opened one). Then call wait_for_work again.`

/** Just the one card. */
export const cardPrompt = (id: string) => `Use the Binders tools to do card ${id}: claim_task it, read it with get_task (and get_note for its note), do what it asks, report_progress as you go, and complete_task when it's done.`
