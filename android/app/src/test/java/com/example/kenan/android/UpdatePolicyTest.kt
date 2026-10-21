package com.example.kenan.android

import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.TimeUnit

class UpdatePolicyTest {
    private val hour = TimeUnit.HOURS.toMillis(1)
    private val now = 1_000 * hour
    private fun automatic(record: InstallerRecord, last: Long? = null) = UpdatePolicy.plan(UpdateTrigger.Automatic, record, now, last)

    @Test fun cancelSnoozesAutomaticPromptsForADayButNotRequests() {
        val declined = InstallerRecord.Declined(7, 11675, now - hour)
        assertTrue(automatic(declined) is UpdatePlan.Hold)
        assertEquals(UpdatePlan.Submit, UpdatePolicy.plan(UpdateTrigger.Requested, declined, now, now))
        assertEquals(UpdatePlan.Submit, automatic(InstallerRecord.Declined(7, 11675, now - 25 * hour)))
    }
    @Test fun realFailuresRetryWithoutWaitingForTheDailyBatch() {
        assertTrue(automatic(InstallerRecord.Failed(7, 11675, now - TimeUnit.MINUTES.toMillis(5), "x"), now - hour) is UpdatePlan.Hold)
        assertEquals(UpdatePlan.Submit, automatic(InstallerRecord.Failed(7, 11675, now - hour, "x"), now - hour))
    }
    @Test fun automaticPromptsAreBatchedToOncePerInterval() {
        assertEquals(UpdatePlan.Submit, automatic(InstallerRecord.Clear))
        assertTrue(automatic(InstallerRecord.Clear, now - 3 * hour) is UpdatePlan.Hold)
        assertEquals(UpdatePlan.Submit, automatic(InstallerRecord.Clear, now - 21 * hour))
        assertTrue(automatic(InstallerRecord.Submitted(7, 11675, now - 2 * hour), now - 2 * hour) is UpdatePlan.Hold)
    }
    @Test fun anOpenConsentScreenIsNeverReplaced() {
        assertTrue(automatic(InstallerRecord.Submitted(7, 11675, now - TimeUnit.MINUTES.toMillis(1))) is UpdatePlan.Hold)
    }
}
