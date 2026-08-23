import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  HttpException,
  Inject,
} from '@nestjs/common';
import {
  idSchema,
  circleListSchema,
  circleMetadataSchema,
  circleDetailSchema,
  circleNotesSchema,
  circleMembersSchema,
  circleInvitationResponseSchema,
  circleJoinRequestsSchema,
} from '@wai/contracts';
import { CurrentSession } from '../account/decorators/current-session.decorator.js';
import { OriginGuard } from '../account/guards/origin.guard.js';
import { SessionAuthGuard } from '../account/guards/session-auth.guard.js';
import type { AuthenticatedSession } from '../account/services/session.service.js';
import { CirclesService } from './circles.service.js';

@Controller('circles')
@UseGuards(SessionAuthGuard)
export class CirclesController {
  constructor(@Inject(CirclesService) private readonly service: CirclesService) {}
  @Post() @UseGuards(OriginGuard) async create(
    @CurrentSession() s: AuthenticatedSession,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return circleMetadataSchema.parse(await this.service.create(s.accountId, b, requiredKey(k)));
  }
  @Get() async list(@CurrentSession() s: AuthenticatedSession, @Query() q: unknown) {
    return circleListSchema.parse(await this.service.list(s.accountId, q));
  }
  @Get(':id') async get(@CurrentSession() s: AuthenticatedSession, @Param('id') id: string) {
    return circleDetailSchema.parse(await this.service.get(s.accountId, parseId(id)));
  }
  @Patch(':id') @UseGuards(OriginGuard) async patch(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return circleMetadataSchema.parse(
      await this.service.patch(s.accountId, parseId(id), b, requiredKey(k)),
    );
  }
  @Post(':id/invitations') @UseGuards(OriginGuard) async invite(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    const invitation = await this.service.invite(s.accountId, parseId(id), b, requiredKey(k));
    return circleInvitationResponseSchema.parse({ invitation_id: invitation.invitationId });
  }
  @Post(':id/invitations/:invitationId/:action') @UseGuards(OriginGuard) async invitation(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
    @Param('action') action: string,
    @Headers('idempotency-key') k?: string,
  ) {
    if (!['accept', 'decline', 'cancel'].includes(action))
      throw new HttpException(
        { code: 'VALIDATION_ERROR', message: 'Invalid invitation action' },
        400,
      );
    await this.service.invitation(
      s.accountId,
      parseId(id),
      parseId(invitationId),
      action as 'accept' | 'decline' | 'cancel',
      requiredKey(k),
    );
    return { ok: true };
  }
  @Post(':id/join-requests') @UseGuards(OriginGuard) async join(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    await this.service.join(s.accountId, parseId(id), b, requiredKey(k));
    return { ok: true };
  }
  @Post(':id/join-requests/withdraw') @UseGuards(OriginGuard) async withdrawJoin(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Headers('idempotency-key') k?: string,
  ) {
    await this.service.withdrawJoin(s.accountId, parseId(id), requiredKey(k));
    return { ok: true };
  }
  @Post(':id/leave') @UseGuards(OriginGuard) async leave(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Headers('idempotency-key') k?: string,
  ) {
    await this.service.leave(s.accountId, parseId(id), requiredKey(k));
    return { ok: true };
  }
  @Post(':id/members/:memberId/:action') @UseGuards(OriginGuard) async member(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Param('action') action: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    if (!['approve', 'decline', 'remove', 'role'].includes(action))
      throw new HttpException({ code: 'VALIDATION_ERROR', message: 'Invalid member action' }, 400);
    await this.service.member(
      s.accountId,
      parseId(id),
      parseId(memberId),
      action as 'approve' | 'decline' | 'remove' | 'role',
      b,
      requiredKey(k),
    );
    return { ok: true };
  }
  @Post(':id/notes') @UseGuards(OriginGuard) async note(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body() b: unknown,
    @Headers('idempotency-key') k?: string,
  ) {
    return this.service.addNote(s.accountId, parseId(id), b, requiredKey(k));
  }
  @Post(':id/report') @UseGuards(OriginGuard) async reportCircle(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Body() b: unknown,
  ) {
    const r = await this.service.report(s.accountId, 'circle', parseId(id), b);
    return { id: r.id, state: r.state, created_at: r.createdAt.toISOString() };
  }
  @Post(':id/notes/:noteId/report') @UseGuards(OriginGuard) async reportNote(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
    @Body() b: unknown,
  ) {
    // Bind the note to the URL circle before handing it to SAF; this avoids a
    // cross-circle target oracle while retaining an escape after revocation.
    const circleId = parseId(id);
    const parsedNoteId = parseId(noteId);
    const r = await this.service.report(s.accountId, 'note', parsedNoteId, b, circleId);
    return { id: r.id, state: r.state, created_at: r.createdAt.toISOString() };
  }
  @Get(':id/notes') async notes(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return circleNotesSchema.parse(await this.service.notes(s.accountId, parseId(id), q));
  }
  @Get(':id/members') async members(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return circleMembersSchema.parse(await this.service.members(s.accountId, parseId(id), q));
  }
  @Get(':id/join-requests') async joinRequests(
    @CurrentSession() s: AuthenticatedSession,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    return circleJoinRequestsSchema.parse(
      await this.service.joinRequests(s.accountId, parseId(id), q),
    );
  }
}
function parseId(value: string) {
  const p = idSchema.safeParse(value);
  if (!p.success)
    throw new HttpException({ code: 'VALIDATION_ERROR', message: 'Circle id is invalid' }, 400);
  return p.data;
}
function requiredKey(value: string | undefined) {
  if (!value || value.length < 16 || value.length > 128)
    throw new HttpException(
      { code: 'VALIDATION_ERROR', message: 'Idempotency-Key is invalid' },
      400,
    );
  return value;
}
