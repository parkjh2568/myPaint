#include "canvas.h"
#include <QApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMouseEvent>
#include <QPointingDevice>
#include <QTabletEvent>
#include <QTest>
#include <cmath>
#include <cstdio>
#include <vector>
using namespace paint;
struct Case {
    QString name;
    QPointF from{6, 6}, to{6, 6};
    QColor foreground{Qt::red}, target{Qt::blue}, fill{Qt::red};
    int thickness=4, opacity=100, hardness=100, stabilization=25;
    bool right=false, square=false, hidden=false, cancel=false, redoSeed=false, tablet=false, aliases=false;
    double zoom=1, pressure=1;
};
int main(int argc,char **argv) {
    QApplication app(argc,argv);
    app.setApplicationName("myPaint-ColorEraser-isolated-oracle");
    app.setOrganizationName("myPaint-ColorEraser-isolated-oracle");
    std::vector<Case> cases;
    cases.push_back({.name="click-local-disk"});
    cases.push_back({.name="horizontal-capsule",.from={4,6},.to={12,6}});
    cases.push_back({.name="diagonal-odd-size",.from={4,4},.to={12,12},.thickness=3});
    cases.push_back({.name="vertical-capsule",.from={9,4},.to={9,14},.thickness=5});
    cases.push_back({.name="fractional-floor-zoom2",.from={6.9,7.9},.to={12.9,7.9},.zoom=2});
    cases.push_back({.name="right-still-foreground-to-target",.right=true});
    cases.push_back({.name="opacity-hardness-stabilization-square-ignored",.opacity=0,.hardness=0,.stabilization=75,.square=true});
    cases.push_back({.name="size1-single-integer-pixel",.thickness=1});
    cases.push_back({.name="low-alpha-premultiplied-aliases",.foreground={40,80,120,1},.target={77,144,219,128},.fill={200,80,120,1},.aliases=true});
    cases.push_back({.name="alpha0-hidden-RGB-key-equivalence",.foreground={10,99,177,0},.target={77,144,219,128},.fill={199,23,71,0}});
    cases.push_back({.name="target-alpha-preserved",.target={77,144,219,128}});
    cases.push_back({.name="hidden-layer-exposed-on-commit",.hidden=true});
    cases.push_back({.name="hidden-layer-cancel-restores",.from={4,6},.to={12,6},.hidden=true,.cancel=true});
    cases.push_back({.name="no-match-keeps-redo",.foreground={Qt::green},.redoSeed=true});
    cases.push_back({.name="hidden-no-match-still-exposes-with-history",.foreground={Qt::green},.hidden=true});
    cases.push_back({.name="tablet-low-pressure-ignored",.from={4,6},.to={12,6},.tablet=true,.pressure=.01});
    cases.push_back({.name="tablet-high-pressure-ignored",.from={4,6},.to={12,6},.tablet=true,.pressure=1});
    cases.push_back({.name="large-size-clips-image",.from={1,1},.to={1,1},.thickness=100});
    QJsonArray records,errors;
    for (const auto &c:cases) {
        Document doc(QSize(32,24));
        State state=doc.state();
        state.layers[0].image.fill(c.fill);
        state.layers[0].visible=!c.hidden;
        if(c.aliases){state.layers[0].image.setPixelColor(6,6,QColor(1,2,3,1));state.layers[0].image.setPixelColor(7,6,QColor(40,80,120,1));}
        doc.reset(state);
        if(c.redoSeed){auto seed=doc.state();seed.layers[0].image.setPixelColor(30,22,Qt::yellow);doc.commit(seed,"redo seed");doc.undo();}
        const auto before=doc.state().layers[0].image;
        const auto revision=doc.revision();
        const bool redoBefore=doc.canRedo(),visibleBefore=doc.state().layers[0].visible;
        Canvas canvas(doc);
        QObject::connect(&canvas,&Canvas::errorOccurred,[&](const QString &message){errors.append(message);});
        canvas.foreground=c.foreground;canvas.background=c.target;canvas.thickness=c.thickness;
        canvas.brushOpacity=c.opacity;canvas.brushHardness=c.hardness;canvas.brushStabilization=c.stabilization;
        canvas.brushSquare=c.square;canvas.pressureEnabled=true;canvas.setZoom(c.zoom);canvas.setTool(Tool::ColorEraser);canvas.show();
        QPointingDevice pen("oracle pen",92,QInputDevice::DeviceType::Stylus,QPointingDevice::PointerType::Pen,QInputDevice::Capability::Position|QInputDevice::Capability::Pressure,1,1);
        const auto button=c.right?Qt::RightButton:Qt::LeftButton;
        auto send=[&](QEvent::Type type,QPointF point){
            point*=c.zoom;
            if(c.tablet){const auto tabletType=type==QEvent::MouseButtonPress?QEvent::TabletPress:type==QEvent::MouseButtonRelease?QEvent::TabletRelease:QEvent::TabletMove;QTabletEvent event(tabletType,&pen,point,point,c.pressure,0,0,0,0,0,Qt::NoModifier,type==QEvent::MouseMove?Qt::NoButton:button,type==QEvent::MouseButtonRelease?Qt::NoButton:button);QApplication::sendEvent(&canvas,&event);}
            else {QMouseEvent event(type,point,point,type==QEvent::MouseMove?Qt::NoButton:button,type==QEvent::MouseButtonRelease?Qt::NoButton:button,Qt::NoModifier);QApplication::sendEvent(&canvas,&event);}
        };
        send(QEvent::MouseButtonPress,c.from);send(QEvent::MouseMove,c.to);
        const bool committedDuringDrag=doc.revision()!=revision;
        const bool documentVisibilityDuringDrag=doc.state().layers[0].visible;
        const bool pendingVisibility=canvas.pendingState().layers[0].visible;
        if(c.cancel){QPixmap target(canvas.size());canvas.render(&target);canvas.cancel();}
        send(QEvent::MouseButtonRelease,c.to);
        const auto after=doc.state().layers[0].image;
        const bool canUndo=doc.canUndo(),visibleAfter=doc.state().layers[0].visible,dirty=doc.dirty();
        auto rgba=[](QRgb value){return QJsonArray{qRed(value),qGreen(value),qBlue(value),qAlpha(value)};};
        QJsonArray changed;
        for(int y=0;y<after.height();y++)for(int x=0;x<after.width();x++)if(before.pixel(x,y)!=after.pixel(x,y))changed.append(QJsonObject{{"x",x},{"y",y},{"beforePremultipliedRGBA",rgba(before.pixel(x,y))},{"afterPremultipliedRGBA",rgba(after.pixel(x,y))},{"afterStraightRGBA",rgba(after.pixelColor(x,y).rgba())}});
        QJsonObject result{{"name",c.name},{"from",QJsonArray{c.from.x(),c.from.y()}},{"to",QJsonArray{c.to.x(),c.to.y()}},{"integerFrom",QJsonArray{int(std::floor(c.from.x())),int(std::floor(c.from.y()))}},{"integerTo",QJsonArray{int(std::floor(c.to.x())),int(std::floor(c.to.y()))}},{"thickness",c.thickness},{"foregroundRGBA",rgba(c.foreground.rgba())},{"targetRGBA",rgba(c.target.rgba())},{"keyPremultipliedRGBA",rgba(qPremultiply(c.foreground.rgba()))},{"targetPremultipliedRGBA",rgba(qPremultiply(c.target.rgba()))},{"changed",changed},{"committedDuringDrag",committedDuringDrag},{"visibilityBefore",visibleBefore},{"documentVisibilityDuringDrag",documentVisibilityDuringDrag},{"pendingVisibility",pendingVisibility},{"visibilityAfter",visibleAfter},{"dirty",dirty},{"canUndo",canUndo},{"canRedoBefore",redoBefore},{"canRedoAfter",doc.canRedo()},{"cancel",c.cancel}};
        if(canUndo){doc.undo();result["undoExact"]=doc.state().layers[0].image==before&&doc.state().layers[0].visible==visibleBefore;result["undoClean"]=!doc.dirty();doc.redo();result["redoExact"]=doc.state().layers[0].image==after&&doc.state().layers[0].visible==visibleAfter;}
        records.append(result);
    }
    const auto bytes=QJsonDocument(QJsonObject{{"qt",qVersion()},{"scope","Real legacy Canvas/Document; no MainWindow, recovery paths, user files or modified product source"},{"cases",records},{"errors",errors}}).toJson();
    std::fwrite(bytes.constData(),1,size_t(bytes.size()),stdout);return errors.isEmpty()?0:1;
}
