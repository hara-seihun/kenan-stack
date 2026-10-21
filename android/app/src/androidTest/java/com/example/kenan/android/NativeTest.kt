package com.example.kenan.android

import android.provider.Settings
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun receiptDeduplicatesAcrossProcessStoreAndConflictsOnChangedArgs() {
        context.deleteDatabase("device-receipts.db")
        val frame = JSONObject("""{"type":"command","operationId":"6d3814d2-7c96-48b5-8fc8-13dd46f2aa5c","generation":1,"deadline":1,"sessionEpoch":"epoch","name":"ui.tree","args":{"limit":10},"authorization":{"phoneRequested":true,"confirmed":false}}""")
        val command = (DeviceCommand.parse(frame) as Outcome.Ok).value
        val first = DeviceStore(context)
        assertEquals(DeviceStore.Admission.New, first.accept(command)); first.close()
        val second = DeviceStore(context)
        val retained = second.accept(command) as DeviceStore.Admission.Retained
        assertEquals("outcome_uncertain", retained.result.getJSONObject("error").getString("code"))
        frame.getJSONObject("args").put("limit", 20)
        assertEquals(DeviceStore.Admission.Conflict, second.accept((DeviceCommand.parse(frame) as Outcome.Ok).value))
        second.close()
    }
    @Test fun terminalEvidenceReplaysOriginalEpochUntilOwnerAck() {
        context.deleteDatabase("device-receipts.db")
        val store = DeviceStore(context); store.bind("owner-a", "original")
        val frame = JSONObject("""{"type":"command","operationId":"2e6b6dc6-f8f6-4d0b-a70f-9c0711bd2f5c","generation":3,"deadline":1,"sessionEpoch":"original","name":"ui.tree","args":{"limit":10},"authorization":{"phoneRequested":true,"confirmed":false}}""")
        val command = (DeviceCommand.parse(frame) as Outcome.Ok).value
        assertEquals(DeviceStore.Admission.New, store.accept(command))
        store.finish(command.id, Outcome.Ok(JSONObject().put("nodes", org.json.JSONArray())).json())
        store.bind("owner-a", "reconnected")
        val replay = store.retainedResults("owner-a").single()
        assertEquals("original", replay.getString("sessionEpoch")); assertEquals(3, replay.getInt("generation"))
        store.bind("owner-b", "another-owner"); store.acknowledge(command.id)
        assertTrue(store.retainedResults("owner-b").isEmpty())
        assertEquals(DeviceStore.Admission.Conflict, store.accept(command))
        assertEquals(1, store.retainedResults("owner-a").size)
        store.bind("owner-a", "back"); store.acknowledge(command.id)
        assertTrue(store.retainedResults("owner-a").isEmpty()); store.close()
    }
    @Test fun releasedReplyDedupDoesNotRewindLatestView() {
        context.deleteDatabase("device-receipts.db"); val store = DeviceStore(context)
        val old = JSONObject().put("type", "overlayReply").put("operationId", "17245f57-5ba4-49cf-a6c7-7c49b681a326").put("entryId", "entry1").put("audienceEpoch", 2).put("conversationId", "conversation").put("text", "one")
        val next = JSONObject(old.toString()).put("operationId", "91c45064-47e6-4b86-bd29-ebecac6c64ef").put("entryId", "entry2").put("text", "two")
        assertTrue((store.retainReply("owner", old) as Outcome.Ok).value.getBoolean("display"))
        assertTrue((store.retainReply("owner", next) as Outcome.Ok).value.getBoolean("display"))
        assertFalse((store.retainReply("owner", old) as Outcome.Ok).value.getBoolean("display"))
        assertTrue(store.retainReply("another-owner", old) is Outcome.Err)
        assertTrue(store.retainReply("owner", JSONObject(next.toString()).put("text", "changed")) is Outcome.Err)
        store.close()
    }
    @Test fun ownerChangePreservesLocalChoicesButClearsOldSessionContext() {
        val store = DeviceStore(context); store.bind("first", "epoch-1")
        store.prefs.edit().putBoolean("phoneEnabled", true).putBoolean("overlayEnabled", true).putBoolean("connectionEnabled",true).putString("noticeCursor","old-cursor").putString("conversationId","old-conversation").commit()
        store.bind("second", "epoch-2")
        assertTrue(store.prefs.getBoolean("phoneEnabled", false)); assertTrue(store.prefs.getBoolean("overlayEnabled", false))
        assertNull(store.prefs.getString("noticeCursor",null));assertNull(store.prefs.getString("conversationId",null))
        store.clearSessionBinding();assertNull(store.prefs.getString("sessionEpoch",null))
        assertTrue(store.prefs.getBoolean("phoneEnabled",false));assertTrue(store.prefs.getBoolean("overlayEnabled",false));assertTrue(store.prefs.getBoolean("connectionEnabled",false))
        store.close()
    }
}
