/**
 * Team Invitation API
 *
 * Creates custom invitation tokens and sends branded emails.
 * Only accessible by admin users.
 */

import { auth, clerkClient } from '@clerk/nextjs/server';
import { NextRequest, NextResponse } from 'next/server';
import { createInviteToken, getInviteUrl } from '@/lib/invite-tokens';
import { sendEmail } from '@/lib/email';
import { invitationEmail } from '@/lib/email-templates/invitation';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Get the current user's auth
    const { userId } = await auth();

    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if user is admin
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    const role = (
      user.publicMetadata as { role?: string }
    )?.role?.toLowerCase();

    if (role !== 'admin') {
      return NextResponse.json(
        { error: 'Only admins can invite team members' },
        { status: 403 }
      );
    }

    // Get email from request body
    const body = await request.json();
    const { email } = body;

    if (!email || typeof email !== 'string') {
      return NextResponse.json({ error: 'Email is required' }, { status: 400 });
    }

    // Validate email format without polynomial-time regex
    const at = email.indexOf('@');
    const domain = at > 0 ? email.slice(at + 1) : '';
    const dot = domain.lastIndexOf('.');
    if (
      at <= 0 ||
      at !== email.lastIndexOf('@') ||
      email.length > 254 ||
      dot <= 0 ||
      dot >= domain.length - 1 ||
      /\s/.test(email)
    ) {
      return NextResponse.json(
        { error: 'Invalid email format' },
        { status: 400 }
      );
    }

    // Check if user already exists in Clerk
    const existingUsers = await client.users.getUserList({
      emailAddress: [email],
    });

    if (existingUsers.data.length > 0) {
      return NextResponse.json(
        { error: 'A user with this email already exists' },
        { status: 400 }
      );
    }

    // Get inviter info
    const inviterName = user.firstName
      ? `${user.firstName} ${user.lastName || ''}`.trim()
      : user.primaryEmailAddress?.emailAddress || 'A team member';
    const inviterEmail = user.primaryEmailAddress?.emailAddress || '';

    // Create invitation token
    const token = await createInviteToken({
      email,
      role: 'team',
      invitedBy: userId,
      invitedByEmail: inviterEmail,
    });

    const inviteUrl = getInviteUrl(token);

    // Send invitation email
    const { subject, html, text } = invitationEmail({
      inviterName,
      inviterEmail,
      invitationUrl: inviteUrl,
      expiresInDays: 7,
    });

    const emailResult = await sendEmail({
      to: email,
      subject,
      html,
      text,
    });

    if (!emailResult.success) {
      console.error('[Team Invite] Failed to send email:', emailResult.error);
      return NextResponse.json(
        { error: `Failed to send invitation email: ${emailResult.error}` },
        { status: 500 }
      );
    }

    console.info(
      `[Team Invite] Invitation sent to ${email} by ${inviterEmail}`
    );

    return NextResponse.json({
      success: true,
      message: `Invitation sent to ${email}`,
    });
  } catch (error) {
    console.error('[Team Invite] Error creating invitation:', error);

    return NextResponse.json(
      { error: 'Failed to create invitation' },
      { status: 500 }
    );
  }
}
