"""Unit tests for ``app.serialize`` — snake↔camel conversion."""

from __future__ import annotations

from app.serialize import camel_to_snake, snake_to_camel, to_camel, to_snake


class TestSnakeToCamel:
    def test_simple(self) -> None:
        assert snake_to_camel("hello_world") == "helloWorld"

    def test_no_underscore(self) -> None:
        assert snake_to_camel("hello") == "hello"

    def test_multiple(self) -> None:
        assert snake_to_camel("a_b_c_d") == "aBCD"

    def test_with_digit(self) -> None:
        assert snake_to_camel("change_pct_1d") == "changePct1d"


class TestCamelToSnake:
    def test_simple(self) -> None:
        assert camel_to_snake("helloWorld") == "hello_world"

    def test_no_capital(self) -> None:
        assert camel_to_snake("hello") == "hello"

    def test_already_snake(self) -> None:
        assert camel_to_snake("hello_world") == "hello_world"


class TestToCamel:
    def test_flat_dict(self) -> None:
        assert to_camel({"hello_world": 1, "foo_bar": 2}) == {"helloWorld": 1, "fooBar": 2}

    def test_nested_dict(self) -> None:
        out = to_camel({"outer_key": {"inner_key": [1, 2]}})
        assert out == {"outerKey": {"innerKey": [1, 2]}}

    def test_list_of_dicts(self) -> None:
        assert to_camel([{"a_b": 1}, {"c_d": 2}]) == [{"aB": 1}, {"cD": 2}]

    def test_non_dict_passthrough(self) -> None:
        assert to_camel("hello_world") == "hello_world"
        assert to_camel(42) == 42
        assert to_camel(None) is None


class TestToSnake:
    def test_flat_dict(self) -> None:
        assert to_snake({"helloWorld": 1}) == {"hello_world": 1}

    def test_nested(self) -> None:
        assert to_snake({"outerKey": {"innerKey": 1}}) == {"outer_key": {"inner_key": 1}}
