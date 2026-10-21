package com.example.kenan.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ProtocolTest {
    @Test fun gatewayNeverGuessesIdentityOrPath() {
        listOf("", "example.com", "http://person:secret@host", "http://host/editor", "javascript:alert(1)", "http://host/?token=x").forEach { assertTrue(it, Gateway.parse(it) is Outcome.Err) }
        assertEquals("http://host:18190", (Gateway.parse("http://host:18190/") as Outcome.Ok).value.origin)
    }
    @Test fun durableIdentityIgnoresJsonKeyOrder() {
        assertEquals(canonical(JSONObject("{\"b\":2,\"a\":1}")), canonical(JSONObject("{\"a\":1,\"b\":2}")))
        assertNotEquals(canonical(JSONObject("{\"a\":1}")), canonical(JSONObject("{\"a\":2}")))
    }
    @Test fun commandReceiptIgnoresTransportEpochButNotPayload() {
        val frame = JSONObject("""{"type":"command","operationId":"6d3814d2-7c96-48b5-8fc8-13dd46f2aa5c","generation":1,"deadline":1,"sessionEpoch":"epoch","name":"ui.tree","args":{"limit":10},"authorization":{"phoneRequested":true,"confirmed":false}}""")
        val first = (DeviceCommand.parse(frame) as Outcome.Ok).value.canonical
        frame.put("sessionEpoch", "reconnected").put("deadline", 2)
        assertEquals(first, (DeviceCommand.parse(frame) as Outcome.Ok).value.canonical)
        frame.getJSONObject("args").put("limit", 11)
        assertNotEquals(first, (DeviceCommand.parse(frame) as Outcome.Ok).value.canonical)
    }
    @Test fun errorNamesAreGeneratedAndClosed() {
        assertThrows(IllegalArgumentException::class.java) { Outcome.Err("invented", "invalid state") }
    }
    @Test fun commandRequiresActualPhoneIntentAndExplicitConfirmationField() {
        val frame = JSONObject("""{"type":"command","operationId":"6d3814d2-7c96-48b5-8fc8-13dd46f2aa5c","generation":1,"deadline":1,"sessionEpoch":"epoch","name":"ui.tree","args":{"limit":10},"authorization":{"phoneRequested":true,"confirmed":false}}""")
        assertTrue(DeviceCommand.parse(frame) is Outcome.Ok)
        frame.getJSONObject("authorization").put("phoneRequested", false)
        assertTrue(DeviceCommand.parse(frame) is Outcome.Err)
        frame.getJSONObject("authorization").remove("confirmed")
        assertTrue(DeviceCommand.parse(frame) is Outcome.Err)
    }
}
