package space.tcymc.astering;

final class SessionFence {
    private long epoch;
    private String origin = "";
    private long verifiedEpoch = -1;
    private SessionIdentity owner;
    private String token = "";

    synchronized void bindServer(String value) {
        if (!origin.equals(value)) {
            clear();
            origin = value;
        }
    }

    synchronized boolean set(String value) {
        SessionIdentity next = SessionIdentity.parse(value);
        if (next == null) throw new IllegalArgumentException("authentication");
        boolean changed = owner == null || !owner.sameOwner(next);
        if (!changed && (next.issued < owner.issued || next.expires < owner.expires)) return false;
        if (changed) epoch++;
        owner = next;
        token = value;
        return changed;
    }

    synchronized void clear() {
        epoch++;
        owner = null;
        token = "";
    }

    synchronized boolean markVerified(Ticket ticket) {
        if (!current(ticket)) return false;
        verifiedEpoch = epoch;
        return true;
    }

    synchronized boolean verified(Ticket ticket) {
        return current(ticket) && verifiedEpoch == epoch;
    }

    synchronized Ticket ticket() {
        return owner == null ? null : new Ticket(epoch, origin, owner, token);
    }

    synchronized boolean current(Ticket ticket) {
        return ticket != null && owner != null && epoch == ticket.epoch && origin.equals(ticket.origin) && owner.sameOwner(ticket.owner);
    }

    static final class Ticket {
        final long epoch;
        final String origin;
        final SessionIdentity owner;
        final String token;

        Ticket(long epoch, String origin, SessionIdentity owner, String token) {
            this.epoch = epoch;
            this.origin = origin;
            this.owner = owner;
            this.token = token;
        }
    }
}
