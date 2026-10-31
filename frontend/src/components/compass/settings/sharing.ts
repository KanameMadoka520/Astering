export type CompassSharing = 'personal' | 'team'

/** The team a new space is shared with; the name travels along for the preview and the summary. */
export type CompassTeamChoice = {
	id: number
	name: string
}

type TeamMembership = {
	id?: number
	admin?: boolean
}

/**
 * Only a team admin may share a new space with the team. Decided from the member record alone:
 * a missing record or an unknown flag never counts as admin.
 */
export function isCompassTeamAdmin(
	team: {members?: readonly TeamMembership[] | null},
	userId: number,
): boolean {
	if (userId <= 0) return false
	return (team.members ?? []).some(member => member.id === userId && member.admin === true)
}
