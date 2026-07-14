"""Approval-boundary tests for the optional MCP integration."""

from __future__ import annotations

import asyncio
import importlib
import sys
from types import ModuleType, SimpleNamespace

import pytest


class FakeBrowser:
    instances: list[FakeBrowser] = []

    def __init__(self, **options):
        self.options = options
        self.calls: list[dict] = []
        self.__class__.instances.append(self)

    def run(self, code, **options):
        self.calls.append({"code": code, **options})
        return SimpleNamespace(
            ok=True,
            value="done",
            error=None,
            console=[],
            pages=[],
            challenges=[],
            warnings=[],
            duration_ms=1,
            files=lambda: [],
            screenshots=lambda: [],
        )


class FakeFastMCP:
    def __init__(self, _name):
        pass

    def tool(self):
        return lambda function: function

    def run(self):
        pass


class FakeBaseModel:
    pass


class FakeContext:
    pass


@pytest.fixture
def load_server(monkeypatch):
    loaded = []

    def load(policy="ask"):
        import betterwright

        FakeBrowser.instances.clear()
        monkeypatch.setenv("BETTERWRIGHT_DOWNLOAD_POLICY", policy)
        monkeypatch.setattr(betterwright, "BetterWright", FakeBrowser)

        fastmcp = ModuleType("mcp.server.fastmcp")
        fastmcp.Context = FakeContext
        fastmcp.FastMCP = FakeFastMCP
        fastmcp.Image = object
        monkeypatch.setitem(sys.modules, "mcp", ModuleType("mcp"))
        monkeypatch.setitem(sys.modules, "mcp.server", ModuleType("mcp.server"))
        monkeypatch.setitem(sys.modules, "mcp.server.fastmcp", fastmcp)

        pydantic = ModuleType("pydantic")
        pydantic.BaseModel = FakeBaseModel
        pydantic.Field = lambda **_options: None
        monkeypatch.setitem(sys.modules, "pydantic", pydantic)

        module_name = "betterwright.integrations.mcp_server"
        sys.modules.pop(module_name, None)
        module = importlib.import_module(module_name)
        loaded.append(module_name)
        return module, FakeBrowser.instances[-1]

    yield load
    for module_name in loaded:
        sys.modules.pop(module_name, None)


class DecisionContext:
    def __init__(self, action="accept", approved=True, error=None, events=None):
        self.action = action
        self.approved = approved
        self.error = error
        self.events = events if events is not None else []

    async def elicit(self, message, schema):
        self.events.append(("approval", message, schema))
        if self.error:
            raise self.error
        return SimpleNamespace(
            action=self.action,
            data=SimpleNamespace(approved=self.approved),
        )


def test_ask_mode_approves_before_browser_code_runs(load_server):
    server, browser = load_server()
    events = []
    context = DecisionContext(events=events)
    original_run = browser.run

    def recorded_run(*args, **kwargs):
        events.append(("run", args, kwargs))
        return original_run(*args, **kwargs)

    browser.run = recorded_run
    result = asyncio.run(
        server.browser_download("return 1", context, note="Get report")
    )

    assert [event[0] for event in events] == ["approval", "run"]
    assert "Get report" in events[0][1]
    assert browser.calls == [
        {
            "code": "return 1",
            "session": "default",
            "note": "Get report",
            "approved_downloads": True,
        }
    ]
    assert '"ok": true' in result[0]


@pytest.mark.parametrize(
    ("context", "message"),
    [
        (DecisionContext(action="decline"), "declined or cancelled"),
        (DecisionContext(approved=False), "declined or cancelled"),
        (DecisionContext(error=NotImplementedError()), "cannot present download approval"),
    ],
)
def test_ask_mode_fails_closed_without_approval(load_server, context, message):
    server, browser = load_server()

    with pytest.raises(RuntimeError, match=message):
        asyncio.run(server.browser_download("return 1", context))

    assert browser.calls == []


def test_allow_mode_removes_prompt_but_keeps_approved_worker_run(load_server):
    server, browser = load_server("allow")
    context = DecisionContext(error=AssertionError("must not prompt"))

    asyncio.run(server.browser_download("return 1", context))

    assert context.events == []
    assert browser.calls[0]["approved_downloads"] is True


def test_deny_mode_blocks_before_browser_code_runs(load_server):
    server, browser = load_server("deny")

    with pytest.raises(RuntimeError, match="disabled"):
        asyncio.run(server.browser_download("return 1", DecisionContext()))

    assert browser.calls == []
