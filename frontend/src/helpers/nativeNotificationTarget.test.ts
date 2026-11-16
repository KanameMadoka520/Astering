import {describe, expect, it} from 'vitest'
import {nativeNotificationAction, nativeNotificationTarget} from './nativeNotificationTarget'

const owner = {userID: 1, sid: 'current-session', origin: 'https://personal.example'}
const message = {event: 'openNotification', user_id: 1, sid: owner.sid, server_origin: owner.origin, target: {kind: 'task', id: '7'}}

describe('native notification navigation', () => {
	it.each([
		[{kind: 'task', id: '7'}, {name: 'task.detail', params: {id: '7'}}],
		[{kind: 'project', id: '42'}, {name: 'project.index', params: {projectId: '42'}}],
		[{kind: 'automation', id: '66395029-3496-42f0-9ff0-6a2cf48d42ed'}, {name: 'automations', params: {automationId: '66395029-3496-42f0-9ff0-6a2cf48d42ed'}}],
		[{kind: 'notifications', id: ''}, 'inbox'],
	])('selects only a known SPA target %j', (target, expected) => {
		expect(nativeNotificationAction({...message, target}, owner)).toEqual(expected)
	})
	it.each([
		null, [], 'https://external.example', {kind: 'task', id: 7}, {kind: 'task', id: '-1'},
		{kind: 'task', id: '0'}, {kind: 'task', id: '01'}, {kind: 'task', id: '1e3'},
		{kind: 'task', id: '9007199254740992'}, {kind: 'task', id: '../settings'},
		{kind: 'task', id: '7', url: 'https://external.example'}, {kind: 'admin', id: '1'},
		{kind: 'notifications', id: 'https://external.example'}, {kind: 'automation', id: '../../admin'},
	])('rejects malformed identifiers, commands and URL targets %j', target => {
		expect(nativeNotificationTarget(target)).toBeNull()
	})
	it.each([
		{user_id: 2}, {user_id: '1'}, {sid: 'previous-session'}, {sid: ''},
		{server_origin: 'https://personal.example.attacker.example'}, {server_origin: 'https://personal.example:8443'},
		{event: 'openNote'},
	])('does not let a previous account or server tap navigate this account %j', change => {
		expect(nativeNotificationAction({...message, ...change}, owner)).toBeNull()
	})
	it('rejects taps until a current authenticated session exists', () => {
		expect(nativeNotificationAction(message, {...owner, sid: ''})).toBeNull()
		expect(nativeNotificationAction(message, {...owner, userID: 0})).toBeNull()
	})
})
