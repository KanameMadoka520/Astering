package space.tcymc.astering;

final class SessionFence {
    private long epoch;
    private SessionIdentity owner;
    private String token = "";

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

    synchronized Ticket ticket() {
        return owner == null ? null : new Ticket(epoch, owner, token);
    }

    synchronized boolean current(Ticket ticket) {
        return ticket != null && owner != null && epoch == ticket.epoch && owner.sameOwner(ticket.owner);
    }

    static final class Ticket {
        final long epoch;
        final SessionIdentity owner;
        final String token;

        Ticket(long epoch, SessionIdentity owner, String token) {
            this.epoch = epoch;
            this.owner = owner;
            this.token = token;
        }
    }
}
