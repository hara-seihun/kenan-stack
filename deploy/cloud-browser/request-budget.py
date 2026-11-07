"""mitmproxy addon. Reserve each HTTP dispatch durably, including redirect hops.

Only used by budget-browser's disposable browser. A failed reservation kills the
flow; it must never degrade to after-the-fact network observations.
"""
import json
import os
from pathlib import Path
from mitmproxy import http


class RequestBudget:
    def __init__(self):
        self.path = Path(os.environ['BROWSER_BUDGET_LEDGER'])
        self.failed = False

    def running(self):
        # The launcher holds an exclusive acquisition lock for our entire life.
        self.read()
        Path(os.environ['BROWSER_BUDGET_READY']).touch(mode=0o600)

    def read(self):
        state = json.loads(self.path.read_text())
        if (state.get('version') != 1 or type(state.get('limit')) is not int
                or type(state.get('reserved')) is not int
                or not 0 <= state['reserved'] <= state['limit']):
            raise ValueError('Invalid budget ledger')
        return state

    def write(self, state):
        temporary = self.path.with_suffix('.next')
        with open(temporary, 'w') as file:
            os.chmod(temporary, 0o600)
            json.dump(state, file)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, self.path)
        fd = os.open(self.path.parent, os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def requestheaders(self, flow: http.HTTPFlow):
        try:
            if self.failed:
                flow.kill()
                return
            state = self.read()
            # No opaque upgrades or tunnels can evade the per-request hook.
            unsupported = (flow.request.method == 'CONNECT'
                           or flow.request.headers.get('upgrade')
                           or flow.request.scheme not in ('http', 'https'))
            allowed = os.environ.get('BROWSER_BUDGET_ALLOWED_HOSTS', '').split(',')
            if allowed != [''] and flow.request.host not in allowed:
                unsupported = True
            if unsupported:
                state['refusedProtocol'] = True
                self.write(state)
                flow.kill()
                return
            if state['reserved'] >= state['limit']:
                state['exhausted'] = True
                self.write(state)
                flow.kill()
                return
            # Write-ahead: a crash can waste an allowance, never restore one.
            state['reserved'] += 1
            state['exhausted'] = state['reserved'] == state['limit']
            self.write(state)
        except BaseException:
            self.failed = True
            flow.kill()
            # The launcher treats this marker as a typed enforcement failure.
            Path(os.environ['BROWSER_BUDGET_READY']).unlink(missing_ok=True)

    def responseheaders(self, flow: http.HTTPFlow):
        # No unrequested upgrade may turn a counted HTTP request into a tunnel.
        if flow.response.status_code == 101:
            try:
                state = self.read()
                state['refusedProtocol'] = True
                self.write(state)
            except BaseException:
                self.failed = True
                Path(os.environ['BROWSER_BUDGET_READY']).unlink(missing_ok=True)
            finally:
                flow.kill()


addons = [RequestBudget()]
