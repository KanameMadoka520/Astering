package space.tcymc.astering;

final class RecordingLease {
    final SessionFence.Ticket owner;
    final long noteID;
    final String generation;

    RecordingLease(SessionFence.Ticket owner, long noteID, String generation) {
        if (owner == null || noteID <= 0 || generation == null || generation.isEmpty()) {
            throw new IllegalArgumentException("invalid_recording");
        }
        this.owner = owner;
        this.noteID = noteID;
        this.generation = generation;
    }

    boolean matches(SessionFence.Ticket current, long note) {
        return current != null && note == noteID && owner.epoch == current.epoch && owner.origin.equals(current.origin) && owner.owner.sameOwner(current.owner);
    }

    boolean notificationMatches(String expectedGeneration, long note) {
        return generation.equals(expectedGeneration) && note == noteID;
    }
}
