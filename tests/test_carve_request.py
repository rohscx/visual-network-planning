from __future__ import annotations

import json

import pytest

from app import carve_request as cr


def document(**changes):
    item = dict(id='web', parents=['192.0.2.0/24'], prefix_length=28)
    item.update(changes)
    return dict(version=1, items=[item])


def test_defaults_and_trimming():
    doc = cr.normalize(document(name_template=' {parent}-{n} ', tags=[' x ', 'x'], description=' hi '), 256)
    assert doc['items'][0] == dict(id='web', parents=['192.0.2.0/24'], prefix_length=28,
                                  repeat=1, name_template='{parent}-{n}', tags=['x', 'x'], description='hi')


@pytest.mark.parametrize('raw', [b'{', b'{} prose', b'```{}', b'{"x":1,"x":2}',
                                b'{"x":NaN}', b'{"x":Infinity}', b'\xff', b'[' * 2000])
def test_invalid_json(raw):
    with pytest.raises(cr.RequestError) as exc:
        cr.decode(raw)
    assert exc.value.code == 'invalid_json'
    assert exc.value.status == 400


def test_syntax_location_and_byte_limit():
    with pytest.raises(cr.RequestError) as exc:
        cr.decode(b'{\n bad}')
    assert exc.value.errors[0]['line'] == 2
    with pytest.raises(cr.RequestError) as exc:
        cr.decode(b' ' * (cr.MAX_REQUEST_BYTES + 1))
    assert exc.value.status == 413


@pytest.mark.parametrize('change', [dict(repeat=True), dict(repeat=1.0), dict(repeat='1'),
    dict(repeat=0), dict(repeat=65), dict(prefix_length=33), dict(prefix_length=-1),
    dict(host_count=10), dict(count=3), dict(parents=[]), dict(parents=['192.0.2.1/24']),
    dict(parents=['::/0']), dict(parents=['192.0.2.0/255.255.255.0']),
    dict(parents=['192.0.2.0/24'] * 2), dict(id='bad:id'), dict(id=''),
    dict(name_template='{n:02}'), dict(name_template='{{parent}}'), dict(name_template='{x}'),
    dict(name_template='}'), dict(name_template='x' * 257), dict(description='x' * 4097),
    dict(tags=['']), dict(tags=['x'] * 33), dict(tags=[1]), dict(tags=['x' * 65]),
    dict(unknown='x'), dict(name_template='\ud800')])
def test_invalid_fields(change):
    with pytest.raises(cr.RequestError) as exc:
        cr.normalize(document(**change), 256)
    assert exc.value.code == 'invalid_schema'


@pytest.mark.parametrize('doc', [None, [], 1, {}, {'version': True, 'items': []},
    {'version': 2, 'items': []}, {'version': 1, 'items': [None]},
    {'version': 1, 'items': [dict(id='x', parents=['192.0.2.0/24'])]}])
def test_invalid_documents(doc):
    with pytest.raises(cr.RequestError):
        cr.normalize(doc, 256)


def test_expansion_and_integer_boundaries():
    item = dict(id='split', parents=['192.0.2.0/24'], count=256)
    assert cr.normalize(dict(version=1, items=[item]), 256)
    with pytest.raises(cr.RequestError):
        cr.normalize(dict(version=1, items=[item, dict(item, id='second', count=1)]), 256)
    for field, value in [('host_count', 4294967294), ('prefix_length', 0), ('prefix_length', 32)]:
        assert cr.normalize(dict(version=1, items=[dict(id='x', parents=['0.0.0.0/0'], **{field: value})]), 256)
    for count in [0, 3, 512, True]:
        with pytest.raises(cr.RequestError):
            cr.normalize(dict(version=1, items=[dict(item, count=count)]), 256)
    with pytest.raises(cr.RequestError):
        cr.normalize(dict(version=1, items=[item, item]), 256)
